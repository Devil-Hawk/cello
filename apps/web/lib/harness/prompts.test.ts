// Proves the prompt-document loader resolves apps/web/prompts/*.md via
// `process.cwd()` the same way the deployed function will (see prompts.ts's
// top-of-file note on why `process.cwd()`, not `__dirname`). `pnpm vitest run`
// runs with cwd = apps/web, matching both `next dev` and the Vercel-traced
// function's cwd — this is the closest same-process check available without
// invoking `next build`.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  PROMPT_DOC_NAMES,
  applyPolicy,
  assertPromptDocsResolve,
  composeSystemPrompt,
  getPolicyDoc,
  getSharedDoc,
  getVoiceDoc,
  loadDoc,
  loadModeDoc,
  promptRef,
  withPolicy,
} from './prompts'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('assertPromptDocsResolve', () => {
  it('resolves every known document without throwing', () => {
    expect(() => assertPromptDocsResolve()).not.toThrow()
  })

  it('covers _shared, _voice, and every migrated agent doc today', () => {
    expect([...PROMPT_DOC_NAMES]).toEqual(expect.arrayContaining([
      '_policy',
      '_shared',
      '_voice',
      'cv_tailor',
      'resume_optimizer',
      'outreach',
      'follow_upper',
      'company_researcher',
      'planner',
      'visa',
      'judge_claims',
      'judge_specificity',
      'analyst',
      'distill',
      'memory_extract',
      'company_verify',
      'goal_judge',
      'orchestrator',
      'researcher',
    ]))
  })
})

describe('getSharedDoc', () => {
  it('loads real content with the EXCLUSIVE sources-of-truth table', () => {
    const doc = getSharedDoc()
    expect(doc.length).toBeGreaterThan(500)
    expect(doc).toContain('Sources of Truth (EXCLUSIVE)')
    expect(doc).toContain('profiles.resume_text')
    expect(doc).toContain('ATS Score Bands')
  })

  it('is memoized (same string instance on repeat calls)', () => {
    expect(getSharedDoc()).toBe(getSharedDoc())
  })
})

describe('getVoiceDoc', () => {
  it('loads real content with the hard-ban list', () => {
    const doc = getVoiceDoc()
    expect(doc.length).toBeGreaterThan(300)
    expect(doc).toContain('No em dashes')
    expect(doc).toContain('Self-check')
  })
})

describe('loadModeDoc', () => {
  it('throws a clear, actionable error for a document that does not exist', () => {
    expect(() => loadModeDoc('does_not_exist_agent')).toThrow(/could not read prompt document/)
    expect(() => loadModeDoc('does_not_exist_agent')).toThrow(/outputFileTracingIncludes/)
  })

  it('loadDoc and loadModeDoc resolve the same file for a known name', () => {
    expect(loadModeDoc('_shared')).toBe(loadDoc('_shared'))
  })
})

describe('composeSystemPrompt', () => {
  it('joins shared + voice + mode, in that order, by default', () => {
    const composed = composeSystemPrompt({ mode: 'MODE MARKER: cv_tailor rules go here' })
    const sharedIdx = composed.indexOf('Sources of Truth (EXCLUSIVE)')
    const voiceIdx = composed.indexOf('Voice Guardrail')
    const modeIdx = composed.indexOf('MODE MARKER')
    expect(sharedIdx).toBeGreaterThanOrEqual(0)
    expect(voiceIdx).toBeGreaterThan(sharedIdx)
    expect(modeIdx).toBeGreaterThan(voiceIdx)
  })

  it('omits _voice.md when includeVoice is false', () => {
    const composed = composeSystemPrompt({ mode: 'x', includeVoice: false })
    expect(composed).not.toContain('Voice Guardrail')
  })

  it('appends stableContext last, after the mode block', () => {
    const composed = composeSystemPrompt({ mode: 'MODE MARKER', stableContext: 'RESUME TEXT HERE' })
    expect(composed.indexOf('RESUME TEXT HERE')).toBeGreaterThan(composed.indexOf('MODE MARKER'))
  })

  it('drops an empty/whitespace-only stableContext instead of appending a blank section', () => {
    const composed = composeSystemPrompt({ mode: 'MODE MARKER', stableContext: '   \n  ' })
    expect(composed.trimEnd().endsWith('MODE MARKER')).toBe(true)
  })
})

describe('promptRef (the Langfuse prompt version)', () => {
  it('is the document name and the first 8 hex chars of the SHA-256 of its trimmed text', () => {
    const text = readFileSync(join(process.cwd(), 'prompts', 'cv_tailor.md'), 'utf8').trim()
    const expected = createHash('sha256').update(text).digest('hex').slice(0, 8)
    expect(promptRef('cv_tailor')).toEqual({ name: 'cv_tailor', hash: expected })
    expect(promptRef('cv_tailor')).toEqual(promptRef('cv_tailor')) // stable across calls
  })

  it('differs between documents, so an edit to one never moves another', () => {
    const hashes = new Set(PROMPT_DOC_NAMES.map((n) => promptRef(n).hash))
    expect(hashes.size).toBe(PROMPT_DOC_NAMES.length)
    expect(promptRef('outreach').hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('fails loudly for a document that does not exist, like every other loader here', () => {
    expect(() => promptRef('no_such_doc')).toThrow(/could not read prompt document/)
  })
})

describe('the prompt policy', () => {
  it('has the six numbered rules and no em dash', () => {
    const doc = getPolicyDoc()
    for (let n = 1; n <= 6; n++) expect(doc).toContain(`\n${n}. `)
    expect(doc).not.toContain('\u2014')
  })

  it('composeSystemPrompt starts with the policy', () => {
    for (const includeVoice of [true, false]) {
      expect(composeSystemPrompt({ mode: 'MODE', includeVoice }).startsWith(getPolicyDoc())).toBe(true)
    }
  })

  it('withPolicy puts it in front once and is idempotent', () => {
    const once = withPolicy('Do the task.')
    expect(once.startsWith(getPolicyDoc())).toBe(true)
    expect(once.endsWith('Do the task.')).toBe(true)
    expect(withPolicy(once)).toBe(once)
    expect(withPolicy(composeSystemPrompt({ mode: 'MODE' })).split(getPolicyDoc()).length).toBe(2)
    expect(withPolicy(undefined)).toBe(getPolicyDoc())
  })

  it('applyPolicy covers system, a library system message, and a prompt-only call', () => {
    const a = applyPolicy({ system: 'S', prompt: 'p' })
    expect(a.policy).toBe('added')
    expect(a.opts.system).toContain(getPolicyDoc())

    const composed = applyPolicy({ system: composeSystemPrompt({ mode: 'M' }), prompt: 'p' })
    expect(composed.policy).toBe('composed')

    const msgs = [
      { role: 'system' as const, content: 'extract facts' },
      { role: 'user' as const, content: 'hi' },
    ]
    const b = applyPolicy({ messages: msgs })
    expect(b.opts.system).toBeUndefined()
    expect(b.opts.messages?.[0].content).toContain(getPolicyDoc())
    expect(b.opts.messages?.[1]).toEqual(msgs[1])
    expect(msgs[0].content).toBe('extract facts')

    const c = applyPolicy({ prompt: 'only a prompt' })
    expect(c.opts.system).toBe(getPolicyDoc())
  })
})

describe('the rewritten prompt documents', () => {
  const REWRITTEN = ['planner', 'analyst', 'distill', 'memory_extract', 'company_verify', 'goal_judge'] as const

  it.each(REWRITTEN)('%s states its job, inputs, output, rules and examples, and no em dash', (name) => {
    const doc = loadModeDoc(name)
    for (const heading of ['## Job', '## Inputs', '## Output', '## Rules', '## Examples']) expect(doc, heading).toContain(`\n${heading}\n`)
    expect(doc).not.toContain('\u2014')
  })

  it.each(REWRITTEN)('%s does not paste the policy text (it is added once, centrally)', (name) => {
    expect(loadModeDoc(name)).not.toContain('Facts about the person come only from')
  })
})
