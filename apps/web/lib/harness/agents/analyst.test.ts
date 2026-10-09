// Tests for lib/harness/agents/analyst.ts — ported from packages/agents/src/
// analyst/analyst.test.ts's "a failed analysis never becomes renderable
// advice" and "provider failures are classified, not swallowed" suites (the
// two blocks that pin this module's actual honesty-contract behavior; the
// AnalystAgent-shell tests, the MockLLMClient tests, and the
// CompanyInsightsCache tests are NOT ported — analyst.ts's own header
// explains why the cache is deliberately not carried over, and the rest
// tested packages/agents' now-deleted AgentContext/AnalystAgent shell rather
// than this unit's own parsing/classification logic).
//
// Same zero-network, zero-DB fake-admin style as
// lib/harness/agents/bulk_matcher.test.ts: `analyst` is driven directly with
// a fake AdminClient and a fake ctx.llm, never a real database or model.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { analyst, AnalystError, buildAnalystPrompt, parseAnalysis, THIN_POSTING_CHARS } from './analyst'
import { numberLines, mergeLines } from '@/lib/quality/lines'
import { getPolicyDoc } from '../prompts'
import { MissingKeyError } from '../llm'
import type { AdminClient, LlmResult, LlmRunOptions, StepContext } from '../types'

const JOB_ROW = {
  id: 'job-1',
  title: 'Senior Backend Engineer',
  description:
    'We need a senior engineer who knows Node.js and PostgreSQL.\nYou will own the queueing stack, which uses Kafka.\n' +
    'You will design APIs, review code, and mentor junior engineers on a team that ships weekly. The role reports to the head of platform. ' +
    'We value clear writing and careful testing, and the work touches billing, ledgers and reconciliation every day.',
  viewer_company_id: 'company-1',
  viewer_company_name: 'Acme Corp',
}

/** Minimal fake of the exact chain shapes analyst.ts issues:
 *  `.from('person_jobs').select(...).eq('id', jobId).single()` and
 *  `.from('profiles').select(...).eq('id', userId).single()`. */
function fakeAdmin(opts: { resumeText?: string | null } = {}): AdminClient {
  // 'resumeText' in opts (not `opts.resumeText ?? default`) so an explicit
  // `{ resumeText: null }` — the no-resume test's whole point — isn't
  // silently swapped back to the default by `??` treating null as unset.
  const resumeText = 'resumeText' in opts ? opts.resumeText : 'Eight years of Node.js\nBuilt a Kafka queueing platform\nMentored four engineers'
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { notes: null }, error: null }),
        single: async () => {
          if (table === 'person_jobs') return { data: JOB_ROW, error: null }
          if (table === 'profiles') return { data: { resume_text: resumeText }, error: null }
          throw new Error(`fakeAdmin: unexpected table "${table}"`)
        },
      }
      return builder
    },
  } as unknown as AdminClient
}

function ctxWith(llm: (opts: LlmRunOptions) => Promise<LlmResult>, adminOpts?: { resumeText?: string | null }): StepContext {
  return {
    userId: 'user-1',
    runId: 'run-1',
    stepLabel: 'analyst',
    agentType: 'analyst',
    input: { jobId: 'job-1' },
    deps: {},
    admin: fakeAdmin(adminOpts),
    apiKeys: {},
    llm,
    signal: new AbortController().signal,
  } as StepContext
}

function stubLlm(content: string): (opts: LlmRunOptions) => Promise<LlmResult> {
  return async () => ({ content, tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: 'stub' })
}

function throwingLlm(error: unknown): (opts: LlmRunOptions) => Promise<LlmResult> {
  return async () => {
    throw error
  }
}

describe('a failed analysis never becomes renderable advice', () => {
  // [label, raw model response, expected AnalystError code]
  const badResponses: Array<[string, string, string]> = [
    ['empty completion', '', 'empty_response'],
    ['prose instead of JSON', 'I am sorry, I cannot help with that request.', 'unparseable_response'],
    ['truncated JSON', '{"summary": "It is a good f', 'unparseable_response'],
    ['malformed JSON', '{"summary": "ok", "talkingPoints": [oops]}', 'unparseable_response'],
    // parseJsonLoose (lib/harness/llm.ts) parses this as valid JSON (a real
    // array) rather than failing to parse — the shape check that follows
    // rejects it as incomplete_response, not unparseable_response. This is a
    // genuine, deliberate divergence from packages/agents' old regex-first
    // parser (which required a leading '{' and so never got this far).
    ['a JSON array, not an analysis', '["not", "an", "analysis"]', 'incomplete_response'],
    [
      'valid JSON with nothing in it',
      JSON.stringify({ summary: '', talkingPoints: [], companyInsights: [] }),
      'incomplete_response',
    ],
    [
      'sections but no summary',
      JSON.stringify({ summary: '   ', talkingPoints: [{ text: 'Node.js work', cites: ['R1', 'J2'] }] }),
      'incomplete_response',
    ],
    [
      'a summary with no sections at all',
      JSON.stringify({ summary: 'A backend role.', talkingPoints: [], companyInsights: [] }),
      'incomplete_response',
    ],
    [
      'wrong types throughout',
      JSON.stringify({ summary: 42, talkingPoints: 'nope', companyInsights: {} }),
      'incomplete_response',
    ],
  ]

  it.each(badResponses)('throws a typed AnalystError for %s', async (_label, response, code) => {
    let thrown: unknown
    try {
      await analyst(ctxWith(stubLlm(response)))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AnalystError)
    expect((thrown as AnalystError).code).toBe(code)
  })

  it('keeps a partial BUT REAL analysis: only sections the model actually wrote', async () => {
    const response = JSON.stringify({
      summary: 'A backend role that leans on your Node.js work.',
      talkingPoints: [],
      companyInsights: [{ text: 'The posting says they run a queueing stack on Kafka.', cites: ['J3'] }],
    })
    const result = await analyst(ctxWith(stubLlm(response)))
    const output = result.output as { summary: string; talkingPoints: string[]; companyInsights: string[] }
    expect(output.summary).toContain('Node.js')
    expect(output.talkingPoints).toEqual([])
    expect(output.companyInsights).toHaveLength(1)
  })
})

describe('the prompt and what comes back are cited', () => {
  const RESUME = 'Senior Engineer\nBuilt a Kafka queueing platform at 4,000 requests per second\nMentored four engineers'
  const DESC = 'Own the queueing stack on Kafka. Mentor junior engineers. '.repeat(8)
  const built = buildAnalystPrompt({ jobTitle: 'Backend Engineer', jobDescription: DESC, companyName: 'Acme', resumeText: RESUME })

  it('numbers the resume as R lines and the posting as J lines, framed as untrusted, with the title as J1', () => {
    expect(built.prompt).toContain('R2: Built a Kafka queueing platform at 4,000 requests per second')
    expect(built.prompt).toContain('J1: Backend Engineer')
    expect(built.prompt).toMatch(/\[\[BEGIN UNTRUSTED JOB POSTING [0-9a-f]+\]\][\s\S]*J2: Own the queueing stack/)
    expect(built.prompt).toContain('POSTING LENGTH: full')
    expect(built.thin).toBe(false)
  })

  it('composes the policy and the analyst document into the system prompt', () => {
    expect(built.system.startsWith(getPolicyDoc())).toBe(true)
    expect(built.system).toContain('Write notes on how one person fits one job')
  })

  it('a posting under the threshold is marked short', () => {
    const thin = buildAnalystPrompt({ jobTitle: 'Engineer', jobDescription: 'x'.repeat(THIN_POSTING_CHARS - 1), companyName: 'Acme', resumeText: RESUME })
    expect(thin.thin).toBe(true)
    expect(thin.prompt).toContain('POSTING LENGTH: short')
    expect(buildAnalystPrompt({ jobTitle: 'Engineer', jobDescription: null, companyName: 'Acme', resumeText: RESUME }).thin).toBe(true)
  })

  const lines = mergeLines(numberLines(RESUME, 'R'), numberLines(`Backend Engineer\n${DESC}`, 'J', { maxLines: 20 }))
  const good = { text: 'You built a Kafka queueing platform, which matches owning their queueing stack.', cites: ['R2', 'J2'] }

  it('keeps cited items and drops the ones whose citations do not exist or do not match', () => {
    const out = parseAnalysis(
      JSON.stringify({
        summary: 'A backend role.',
        talkingPoints: [good, { text: 'You led a team of forty.', cites: ['R9'] }, { text: 'You know Rust.', cites: ['R1'] }, 'a bare string', { text: 'No cites at all', cites: [] }],
        companyInsights: [{ text: 'They run Kafka queueing.', cites: ['J2'] }],
      }),
      lines,
      false
    )
    expect(out.talkingPoints).toEqual([good.text])
    expect(out.companyInsights).toEqual(['They run Kafka queueing.'])
    expect(out.thin).toBe(false)
  })

  it('a short posting gets no company insights', () => {
    const out = parseAnalysis(
      JSON.stringify({ summary: 'Too short to say much.', talkingPoints: [], companyInsights: [{ text: 'They run Kafka.', cites: ['J2'] }] }),
      lines,
      true
    )
    expect(out.companyInsights).toEqual([])
    expect(out.thin).toBe(true)
  })

  it('a short posting may be a summary and nothing else, a full one may not', () => {
    const empty = JSON.stringify({ summary: 'The posting is too short to say much.', talkingPoints: [], companyInsights: [] })
    expect(parseAnalysis(empty, lines, true).summary).toContain('too short')
    expect(() => parseAnalysis(empty, lines, false)).toThrow(AnalystError)
  })

  it('items that all lose their citations leave nothing to show for a full posting', () => {
    const raw = JSON.stringify({ summary: 'A backend role.', talkingPoints: [{ text: 'You know Rust.', cites: ['R7'] }], companyInsights: [] })
    expect(() => parseAnalysis(raw, lines, false)).toThrow(/incomplete analysis/)
  })

  it('the unit sends the built prompt at low temperature with its prompt reference', async () => {
    let seen: LlmRunOptions | undefined
    const llm = async (opts: LlmRunOptions): Promise<LlmResult> => {
      seen = opts
      return { content: JSON.stringify({ summary: 'ok', talkingPoints: [{ text: 'Node.js and PostgreSQL experience', cites: ['R1', 'J2'] }], companyInsights: [] }), tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: 'stub' }
    }
    const result = await analyst(ctxWith(llm))
    expect(seen?.temperature).toBe(0.2)
    expect(seen?.promptRef?.name).toBe('analyst')
    expect(seen?.system).toContain(getPolicyDoc())
    expect((result.output as { talkingPoints: string[] }).talkingPoints).toHaveLength(1)
  })
})

describe('provider failures are classified, not swallowed', () => {
  const cases: Array<[number, string, boolean]> = [
    [401, 'provider_auth', false],
    [403, 'provider_auth', false],
    [429, 'rate_limited', true],
    [500, 'provider_error', true],
  ]

  it.each(cases)('HTTP %i is reported as %s', async (status, code, retryable) => {
    const err = Object.assign(new Error('upstream said no'), { status })
    let thrown: unknown
    try {
      await analyst(ctxWith(throwingLlm(err)))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AnalystError)
    expect((thrown as AnalystError).code).toBe(code)
    expect((thrown as AnalystError).retryable).toBe(retryable)
    expect((thrown as AnalystError).providerStatus).toBe(status)
  })

  it('reports a missing key as no_api_key, never analyzing with a mock', async () => {
    let thrown: unknown
    try {
      await analyst(ctxWith(throwingLlm(new MissingKeyError('no key configured'))))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AnalystError)
    expect((thrown as AnalystError).code).toBe('no_api_key')
    expect((thrown as AnalystError).retryable).toBe(false)
  })

  it('reports a missing resume as no_resume so the UI can point at Settings', async () => {
    let thrown: unknown
    try {
      await analyst(ctxWith(stubLlm('{}'), { resumeText: null }))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AnalystError)
    expect((thrown as AnalystError).code).toBe('no_resume')
    expect((thrown as AnalystError).retryable).toBe(false)
  })

  it('classifies an unrecognised throw as a retryable provider error, not a result', async () => {
    let thrown: unknown
    try {
      await analyst(ctxWith(throwingLlm(new Error('socket hang up'))))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AnalystError)
    expect((thrown as AnalystError).code).toBe('provider_error')
    expect((thrown as AnalystError).retryable).toBe(true)
    expect((thrown as AnalystError).message).toBe('socket hang up')
  })
})

// Source-level guard, in the spirit of lib/harness/spend-chokepoints.test.ts
// and packages/agents/src/analyst/analyst.test.ts's own version of this
// check: analyst.ts never had the createFallbackResponse() bug, and this
// keeps it that way — a re-introduced canned-advice fallback has to delete
// this test to ship, which is a much louder act than adding a function.
describe('no canned analysis text exists in the analyst source', () => {
  const FABRICATED_PHRASES = [
    'Unable to generate analysis',
    'Unable to generate summary',
    'Glassdoor',
    'Review the job description and identify matching skills',
    'Practice explaining your past projects clearly',
    'Prepare questions to ask the interviewer',
  ]

  // Comments are stripped first: this file's own header quotes the deleted
  // filler verbatim (same as packages/agents/src/analyst/errors.ts did) to
  // explain why it must never come back — that explanation is the most
  // valuable thing stopping a re-introduction. What must not exist is a
  // phrase the module can RETURN.
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it.each(FABRICATED_PHRASES)('does not contain %s', (phrase) => {
    const src = stripComments(readFileSync(path.join(__dirname, 'analyst.ts'), 'utf8'))
    expect(src).not.toContain(phrase)
  })
})
