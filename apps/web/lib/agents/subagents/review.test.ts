import { describe, expect, it } from 'vitest'
import { MissingKeyError } from '@/lib/harness/llm'
import { BudgetCapError } from '@/lib/harness/spend'
import { bannedPhrases, codeChecks, countAsks, reviewDraft, sourceLinesFor, wordCount } from './review'

const RESUME = 'Dana Lee. Senior engineer at Acme from 2019 to 2024. Built the billing system and cut release time by 40%.'
const admin = {} as never
const base = { admin, userId: 'u1', apiKeys: { openrouter: 'k' } }

describe('code checks', () => {
  it('finds banned words, openers and the em dash, and nothing in plain text', () => {
    expect(bannedPhrases('I will leverage synergy \u2014 it is seamless')).toEqual(['leverage', 'synergy', 'seamless', 'an em dash'])
    expect(bannedPhrases('I am excited to share. Just checking in.')).toEqual(['i am excited to', 'just checking in'])
    expect(bannedPhrases('I built the billing system at Acme.')).toEqual([])
  })

  it('counts asks', () => {
    expect(countAsks('Could we talk? Could you send a referral?')).toBe(2)
    expect(countAsks('Please let me know if you are open to a chat.')).toBe(1)
    expect(countAsks('I built a system.')).toBe(0)
  })

  it('counts words', () => {
    expect(wordCount('  one two   three ')).toBe(3)
    expect(wordCount('')).toBe(0)
  })

  it('flags a claim the resume does not support and names it', () => {
    const checks = codeChecks({ kind: 'cover_letter', text: 'I ran the payments team at Google for ' + 'many years. '.repeat(40), resumeText: RESUME })
    const claims = checks.find((c) => c.name === 'Claims match your resume')
    expect(claims?.ok).toBe(false)
    expect(claims?.detail).toMatch(/Google/)
  })

  it('allows the company, the title, the contact and the sender to be named', () => {
    const text = `Hi Sam, I built the billing system at Acme and cut release time by 40%, and I would like the Product Engineer role at Stripe. Could we talk for ten minutes about how the team works day to day?`
    const checks = codeChecks({
      kind: 'outreach_email',
      text,
      resumeText: RESUME,
      job: { title: 'Product Engineer', company: 'Stripe', description: null },
      contactName: 'Sam Rivera',
    })
    expect(checks.every((c) => c.ok), JSON.stringify(checks)).toBe(true)
  })

  it('applies different length windows to different documents', () => {
    const short = 'Hi Sam, I built billing at Acme and cut release time by 40%. Could we talk about the open role on your team?'
    expect(codeChecks({ kind: 'outreach_email', text: short, resumeText: RESUME }).find((c) => c.name === 'Length fits')?.ok).toBe(false)
    expect(codeChecks({ kind: 'follow_up', text: short, resumeText: RESUME }).find((c) => c.name === 'Length fits')?.ok).toBe(true)
  })
})

describe('the judge', () => {
  const draft = { kind: 'follow_up' as const, text: 'Hi Sam, I built billing at Acme and cut release time by 40%. Could we talk about the open role on your team?', resumeText: RESUME, contactName: 'Sam Rivera' }

  it('reads the draft against numbered resume lines and the role as numbered job lines', async () => {
    let seen: { sources: { id: string }[] } | undefined
    await reviewDraft({ ...base, judge: async (i) => ((seen = i), { verdict: 'pass' as const }) }, { ...draft, job: { title: 'Product Engineer', company: 'Stripe', description: 'Build payments.' } })
    expect(seen?.sources.some((l) => l.id.startsWith('R'))).toBe(true)
    expect(seen?.sources.some((l) => l.id.startsWith('J'))).toBe(true)
    expect(sourceLinesFor({ ...draft }).every((l) => l.id.startsWith('R'))).toBe(true)
  })

  it('names a judge from another family than the default writer', async () => {
    const r = await reviewDraft({ ...base, judge: async () => ({ verdict: 'pass' as const }) }, draft)
    expect(r.judge).toMatchObject({ status: 'passed', model: 'google/gemini-2.5-flash' })
    const withKey = await reviewDraft({ ...base, apiKeys: { openrouter: 'k', model: 'openai/gpt-5.2' }, judge: async () => ({ verdict: 'pass' as const }) }, draft)
    expect(withKey.judge.model).toBe('anthropic/claude-haiku-4.5')
  })

  it('a failed verdict fails the review and names each statement no line backs', async () => {
    const r = await reviewDraft({ ...base, judge: async () => ({ verdict: 'fail' as const, unsupported: [{ text: 'cut release time by 90%' }] }) }, draft)
    expect(r.passed).toBe(false)
    expect(r.judge).toMatchObject({ status: 'failed' })
    expect(r.issues.at(-1)).toBe('Remove or rewrite "cut release time by 90%". Nothing in your resume or the role says this.')
  })

  it('a failed verdict with no statements named still says a second reader objected', async () => {
    const r = await reviewDraft({ ...base, judge: async () => ({ verdict: 'fail' as const }) }, draft)
    expect(r.issues.at(-1)).toMatch(/second reader/)
  })

  it('a missing key and a reached budget are skipped, never a pass or a fail', async () => {
    const noKey = await reviewDraft({ ...base, judge: async () => Promise.reject(new MissingKeyError('x')) }, draft)
    const capped = await reviewDraft({ ...base, judge: async () => Promise.reject(new BudgetCapError(1, 1)) }, draft)
    expect(noKey.judge.status).toBe('skipped')
    expect(capped.judge.status).toBe('skipped')
    expect(noKey.passed && capped.passed).toBe(true)
  })

  it('an answer the judge could not read is skipped', async () => {
    const r = await reviewDraft({ ...base, judge: async () => ({ verdict: 'insufficient-data' as const, summary: 'Not checked.' }) }, draft)
    expect(r.judge).toMatchObject({ status: 'skipped', reason: 'Not checked.' })
  })
})
