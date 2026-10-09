import { describe, expect, it } from 'vitest'
import type { LlmRunner } from '../harness/types'
import { resumeLines, jobLines } from '../resume/lines'
import { judgeClaims, judgeModelFor, judgeSpecificity } from './claims-judge'

function runner(answer: unknown): { run: LlmRunner; seen: { prompt: string; system: string }[] } {
  const seen: { prompt: string; system: string }[] = []
  const run: LlmRunner = async (opts) => {
    seen.push({ prompt: opts.prompt ?? '', system: opts.system ?? '' })
    return { content: typeof answer === 'string' ? answer : JSON.stringify(answer), tokensUsed: 10, promptTokens: 5, completionTokens: 5, model: 'm' }
  }
  return { run, seen }
}

const sources = resumeLines('Led the card-authorization service (Go) at 4,000 requests/sec\nMentor 4 engineers')

describe('judgeModelFor', () => {
  it('never judges with the writer family', () => {
    expect(judgeModelFor('anthropic/claude-sonnet-5')).not.toMatch(/^anthropic\//)
    expect(judgeModelFor('google/gemini-2.5-flash')).toMatch(/^anthropic\//)
    expect(judgeModelFor('openai/gpt-5')).toMatch(/^anthropic\//)
  })
})

describe('judgeClaims', () => {
  it('passes when every claim cites a line that exists', async () => {
    const { run } = runner({ claims: [{ text: 'I led the card-authorization service', about: 'sender', source: 'R1', status: 'supported' }] })
    const res = await judgeClaims(run, { text: 'I led the card-authorization service.', sources })
    expect(res).toMatchObject({ name: 'groundedness', verdict: 'pass', score: 1 })
  })

  it('counts a cited id that is not in the sources as unsupported', async () => {
    const { run } = runner({ claims: [{ text: 'I ran a team of 8', about: 'sender', source: 'R99', status: 'supported' }] })
    const res = await judgeClaims(run, { text: 'I ran a team of 8.', sources })
    expect(res.verdict).toBe('fail')
    expect(res.unsupported).toHaveLength(1)
    expect(res.summary).toBe('Not in your sources: "I ran a team of 8"')
  })

  it('counts a supported claim whose number is not on the cited line as unsupported', async () => {
    const { run } = runner({ claims: [{ text: 'I mentor 12 engineers', about: 'sender', source: 'R2', status: 'supported' }] })
    const res = await judgeClaims(run, { text: 'I mentor 12 engineers.', sources })
    expect(res.verdict).toBe('fail')
    expect(res.unsupported[0].source).toBeNull()
  })

  it('treats a contradicted claim as a failure', async () => {
    const { run } = runner({ claims: [{ text: 'I mentor 12 engineers', about: 'sender', source: 'R2', status: 'contradicted' }] })
    expect((await judgeClaims(run, { text: 'I mentor 12 engineers.', sources })).verdict).toBe('fail')
  })

  it('refuses when the answer has no claims for a draft with text, or is not JSON', async () => {
    const empty = await judgeClaims(runner({ claims: [] }).run, { text: 'I led a team.', sources })
    expect(empty).toMatchObject({ verdict: 'insufficient-data', score: null })
    const junk = await judgeClaims(runner('no json here').run, { text: 'I led a team.', sources })
    expect(junk.verdict).toBe('insufficient-data')
  })

  it('shows the model numbered sources and fences the job post as data', async () => {
    const { run, seen } = runner({ claims: [{ text: 'x', about: 'role', source: 'J1', status: 'supported' }] })
    await judgeClaims(run, { text: 'x', sources: [...sources, ...jobLines('Own the payments path.')] })
    expect(seen[0].prompt).toContain('R1: Led the card-authorization service')
    expect(seen[0].prompt).toContain('J1: Own the payments path.')
    expect(seen[0].prompt).toMatch(/BEGIN UNTRUSTED JOB POST/)
  })
})

describe('judgeSpecificity', () => {
  const lines = jobLines('You will own the card-authorization path.\nWe run Go and Kafka.')
  const text = 'I ran a card-authorization service, which is the path you describe.'

  it('puts the job text in front of the judge', async () => {
    const { run, seen } = runner({ specific: true, detail: 'card-authorization service', source: 'J1', why: 'ties to J1' })
    const res = await judgeSpecificity(run, { text, jobLines: lines, facts: [], role: 'Senior Backend Engineer', company: 'Ramp' })
    expect(seen[0].prompt).toContain('J1: You will own the card-authorization path.')
    expect(res).toMatchObject({ name: 'specificity', verdict: 'pass', source: 'J1' })
  })

  it('fails a detail that shares no word with the line it cites', async () => {
    const { run } = runner({ specific: true, detail: 'great culture', source: 'J1', why: 'x' })
    const res = await judgeSpecificity(run, { text: 'I like the great culture there.', jobLines: lines, facts: [], role: 'r', company: 'c' })
    expect(res.verdict).toBe('fail')
  })

  it('fails a detail that is not in the draft', async () => {
    const { run } = runner({ specific: true, detail: 'Kafka pipelines', source: 'J2', why: 'x' })
    expect((await judgeSpecificity(run, { text, jobLines: lines, facts: [], role: 'r', company: 'c' })).verdict).toBe('fail')
  })

  it('says so when nothing about the role is on file', async () => {
    const res = await judgeSpecificity(runner({}).run, { text, jobLines: [], facts: [], role: 'r', company: 'c' })
    expect(res).toMatchObject({ verdict: 'insufficient-data', summary: 'Nothing about this role or company is on file, so this could not be checked.' })
  })
})
