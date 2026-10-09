import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmRunner } from '../types'
import { MissingKeyError } from '../providers'
import { BudgetCapError } from '../spend'
import { checkDraft } from '@/lib/writing/checks'
import { fallbackOutreachDraft, generateOutreachDraft, type OutreachDraftInput } from './outreach'

const base: OutreachDraftInput = {
  userName: 'Marcus Delgado',
  userEmail: 'marcus@example.com',
  jobTitle: 'Senior Backend Engineer',
  companyName: 'Ramp',
  contactName: 'Jane Park',
  contactTitle: 'Engineering Manager',
  resumeText: 'Marcus Delgado\nDesigned an idempotent double-entry ledger\nMentor 4 engineers',
  jobDescription: 'You will own the ledger that records every payout.',
  kind: 'initial',
}

function llm(content: string, tokensUsed = 33): { run: LlmRunner; calls: { system: string; prompt: string }[] } {
  const calls: { system: string; prompt: string }[] = []
  const run: LlmRunner = async (opts) => {
    calls.push({ system: opts.system ?? '', prompt: opts.prompt ?? '' })
    return { content, tokensUsed, promptTokens: 0, completionTokens: 0, model: 'm' }
  }
  return { run, calls }
}

const failing = (err: unknown): LlmRunner => async () => {
  throw err
}

describe('a model draft', () => {
  it('is returned as source model with the subject and body', async () => {
    const res = await generateOutreachDraft(llm(JSON.stringify({ subject: 'S', body: 'Hi Jane,\n\nB\n\nThanks,\nMarcus Delgado' })).run, base)
    expect(res).toMatchObject({ subject: 'S', source: 'model', tokensUsed: 33 })
    expect(res.templateReason).toBeUndefined()
  })

  it('puts a resume line beyond the old 4,000 character cut into the system prompt', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Resume line ${i} ${'x'.repeat(40)}`).join('\n')
    expect(long.length).toBeGreaterThan(5000)
    const { run, calls } = llm('{"subject":"S","body":"B"}')
    await generateOutreachDraft(run, { ...base, resumeText: `${long}\nFinal line shipped Kafka at scale` })
    expect(calls[0].system).toContain('Final line shipped Kafka at scale')
    expect(calls[0].system).toMatch(/R121: Final line shipped Kafka at scale/)
  })

  it('numbers the job post and fences it as data, and tells the writer when there is none', async () => {
    const withJob = llm('{"subject":"S","body":"B"}')
    await generateOutreachDraft(withJob.run, base)
    expect(withJob.calls[0].prompt).toContain('J1: You will own the ledger that records every payout.')
    expect(withJob.calls[0].prompt).toMatch(/BEGIN UNTRUSTED JOB POST/)
    const without = llm('{"subject":"S","body":"B"}')
    await generateOutreachDraft(without.run, { ...base, jobDescription: null, jobTitle: null })
    expect(without.calls[0].prompt).toContain('No job post on file.')
    expect(without.calls[0].prompt).toContain('No specific role. Write to the team at Ramp')
    expect(without.calls[0].prompt).not.toContain('a role')
  })

  it('gives the writer research with links and recorded history, or says there is none', async () => {
    const rich = llm('{"subject":"S","body":"B"}')
    await generateOutreachDraft(rich.run, {
      ...base,
      facts: [{ id: 'D1', text: 'Ramp ships to production in week one', url: 'https://ramp.com/careers' }],
      history: [{ id: 'H1', text: '2026-09-01 outreach_sent: Initial note' }],
    })
    expect(rich.calls[0].prompt).toContain('D1: Ramp ships to production in week one (https://ramp.com/careers)')
    expect(rich.calls[0].prompt).toContain('H1: 2026-09-01 outreach_sent: Initial note')
    const bare = llm('{"subject":"S","body":"B"}')
    await generateOutreachDraft(bare.run, base)
    expect(bare.calls[0].prompt).toContain('No company research on file.')
    expect(bare.calls[0].prompt).toContain('No earlier contact on record. This is a first contact.')
  })

  it('labels the matcher highlights as hints, not sources', async () => {
    const { run, calls } = llm('{"subject":"S","body":"B"}')
    await generateOutreachDraft(run, { ...base, matchHighlights: ['Go', 'Kafka'] })
    expect(calls[0].prompt).toContain('Fit notes (hints only; every claim must still trace to an R line): Go; Kafka')
    expect(calls[0].prompt).not.toMatch(/Verified/)
  })
})

describe('a follow-up', () => {
  const previous = { subject: 'Senior Backend Engineer at Ramp', body: 'Hi Jane,\n\nThe first email body.\n\nThanks,\nMarcus Delgado', sentAt: '2026-09-20' }

  it('sees the email it follows and how long ago it went out', async () => {
    const { run, calls } = llm('{"subject":"anything","body":"B"}')
    await generateOutreachDraft(run, { ...base, kind: 'follow_up', previousEmail: previous, daysSinceSent: 9 })
    expect(calls[0].prompt).toContain('The first email body.')
    expect(calls[0].prompt).toContain('Sent 9 days ago.')
  })

  it('replies in the thread subject, set by code', async () => {
    const res = await generateOutreachDraft(llm('{"subject":"anything","body":"B"}').run, { ...base, kind: 'follow_up', previousEmail: previous })
    expect(res.subject).toBe('Re: Senior Backend Engineer at Ramp')
    const again = await generateOutreachDraft(llm('{"subject":"x","body":"B"}').run, {
      ...base,
      kind: 'follow_up',
      previousEmail: { ...previous, subject: 'Re: Already a reply' },
    })
    expect(again.subject).toBe('Re: Already a reply')
  })
})

describe('when no model draft can be made, the result says it is the template and why', () => {
  it('unparseable JSON with tokens spent is unusable_output, and keeps the tokens', async () => {
    const res = await generateOutreachDraft(llm('I could not produce JSON, sorry.', 77).run, base)
    expect(res).toMatchObject({ source: 'template', templateReason: 'unusable_output', tokensUsed: 77 })
  })

  it('JSON with no body is unusable_output', async () => {
    const res = await generateOutreachDraft(llm('{"subject":"S"}').run, base)
    expect(res).toMatchObject({ source: 'template', templateReason: 'unusable_output' })
  })

  it.each([
    ['a missing key', new MissingKeyError(), 'missing_key'],
    ['the spending cap', new BudgetCapError(10, 10), 'spend_cap'],
    ['a provider failure', new Error('502 bad gateway'), 'provider_error'],
  ] as const)('%s is %s', async (_label, err, reason) => {
    const res = await generateOutreachDraft(failing(err), base)
    expect(res).toMatchObject({ source: 'template', templateReason: reason, tokensUsed: 0 })
  })
})

describe('the standard template', () => {
  const cases: [string, OutreachDraftInput][] = [
    ['an initial note with role and company', base],
    ['a company-level note with no role', { ...base, jobTitle: null }],
    ['a note with no contact name', { ...base, contactName: null }],
    ['a note with no company at all', { ...base, companyName: null, jobTitle: null }],
    ['a follow-up', { ...base, kind: 'follow_up', previousEmail: { subject: 'Senior Backend Engineer at Ramp', body: `Hi Jane,\n\n${'word '.repeat(60)}\n\nThanks,\nMarcus Delgado` } }],
  ]

  it.each(cases)('passes every check a written draft has to pass: %s', (_label, input) => {
    const draft = fallbackOutreachDraft(input, 'missing_key')
    const res = checkDraft({
      kind: input.kind === 'follow_up' ? 'follow_up' : 'outreach',
      subject: draft.subject,
      body: draft.body,
      senderName: input.userName,
      contactName: input.contactName,
      companyName: input.companyName,
      hasHistory: input.kind === 'follow_up',
      previousBody: input.previousEmail?.body,
    })
    expect(res.checks.filter((c) => !c.ok), draft.body).toEqual([])
    expect(draft).toMatchObject({ source: 'template', templateReason: 'missing_key', tokensUsed: 0 })
  })

  it('makes no claim about the sender and does not print the email address', () => {
    const body = fallbackOutreachDraft({ ...base, matchHighlights: ['Go', 'Kafka'] }).body
    expect(body).not.toContain('Go')
    expect(body).not.toContain('marcus@example.com')
    expect(body).not.toMatch(/a role/)
  })
})

describe('the examples in the prompt document follow the rules the checks enforce', () => {
  const doc = readFileSync(join(process.cwd(), 'prompts', 'outreach.md'), 'utf8')
  const examples = [...doc.matchAll(/```json\n(\{"subject".*\})\n```/g)].map((m) => JSON.parse(m[1]) as { subject: string; body: string })
    .filter((e) => e.body.startsWith('Hi '))

  it('has three examples', () => expect(examples).toHaveLength(3))

  it.each([0, 1, 2])('example %i passes the checks', (i) => {
    const ex = examples[i]
    const sender = ex.body.trim().split('\n').pop() as string
    const greeting = ex.body.split('\n')[0]
    const res = checkDraft({
      kind: i === 2 ? 'follow_up' : 'outreach',
      subject: ex.subject,
      body: ex.body,
      senderName: sender,
      contactName: greeting === 'Hi there,' ? null : 'Jane Park',
      companyName: 'Ramp',
      hasHistory: i === 2,
      previousBody: i === 2 ? 'x '.repeat(100) : null,
    })
    expect(res.checks.filter((c) => !c.ok)).toEqual([])
  })
})
