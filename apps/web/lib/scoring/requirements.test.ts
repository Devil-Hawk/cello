import { describe, expect, it, vi } from 'vitest'
import type { LlmResult, LlmRunOptions } from '@/lib/harness/types'
import { MissingKeyError } from '@/lib/harness/llm'
import { descriptionIsThin, extractRequirements, groundRequirements, quoteIsIn } from './requirements'
import type { RoleFacts } from './types'

const DESC =
  'About us: we build payments tools for thousands of businesses and care a lot about reliability. What you bring: 4+ years of backend engineering. Strong Go or Java. You have run production systems with on-call. Nice to have: Kubernetes. We offer equity and free lunch, plus a generous learning budget for every person on the team.'

function role(id: string, description: string | null = DESC): RoleFacts {
  return { id, title: 'Backend Engineer', company: 'Acme', location: null, description }
}

describe('quoteIsIn', () => {
  it('ignores case, spacing and curly punctuation', () => {
    expect(quoteIsIn('strong  go or java', DESC)).toBe(true)
    expect(quoteIsIn('You’ve run it', 'you\'ve run it daily')).toBe(true)
  })
  it('rejects text that is not there and quotes too short to mean anything', () => {
    expect(quoteIsIn('Rust and WebAssembly', DESC)).toBe(false)
    expect(quoteIsIn('Go', DESC)).toBe(false)
  })
})

describe('groundRequirements', () => {
  const good = (text: string, quote: string, extra: Record<string, unknown> = {}) => ({ text, kind: 'skill', must_have: true, quote, ...extra })

  it('keeps grounded items and drops those whose quote is not in the posting', () => {
    const out = groundRequirements(
      {
        enough_detail: true,
        requirements: [good('Strong Go or Java', 'Strong Go or Java'), good('Rust experience', 'Deep Rust experience'), good('Kubernetes', 'Nice to have: Kubernetes', { must_have: false })],
      },
      DESC
    )
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.requirements.map((r) => r.text)).toEqual(['Strong Go or Java', 'Kubernetes'])
    expect(out.requirements.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(out.requirements[1].mustHave).toBe(false)
  })

  it('merges duplicates and falls back to kind other', () => {
    const out = groundRequirements(
      { requirements: [good('Strong Go or Java', 'Strong Go or Java', { kind: 'wizardry' }), good('strong go or java', 'Strong Go or Java'), good('On call', 'run production systems with on-call')] },
      DESC
    )
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.requirements).toHaveLength(2)
    expect(out.requirements[0].kind).toBe('other')
  })

  it('treats a posting the model calls thin, or with fewer than two grounded items, as thin', () => {
    expect(groundRequirements({ enough_detail: false, requirements: [] }, DESC).kind).toBe('thin')
    expect(groundRequirements({ requirements: [good('Strong Go or Java', 'Strong Go or Java')] }, DESC).kind).toBe('thin')
    expect(groundRequirements('garbage', DESC).kind).toBe('thin')
  })
})

describe('descriptionIsThin', () => {
  it('is true for no description or a sentence', () => {
    expect(descriptionIsThin(null)).toBe(true)
    expect(descriptionIsThin('Join our team as a Product Designer.')).toBe(true)
    expect(descriptionIsThin(DESC)).toBe(false)
  })
})

describe('extractRequirements', () => {
  function llmReturning(content: string | Error) {
    const calls: LlmRunOptions[] = []
    const fn = vi.fn(async (opts: LlmRunOptions): Promise<LlmResult> => {
      calls.push(opts)
      if (content instanceof Error) throw content
      return { content, tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'm' }
    })
    return { fn, calls }
  }

  it('answers a posting with no description without calling the model', async () => {
    const { fn } = llmReturning('{}')
    const out = await extractRequirements(fn, [role('a', null), role('b', 'Join us.')])
    expect(fn).not.toHaveBeenCalled()
    expect(out.get('a')).toMatchObject({ kind: 'thin', reason: 'The posting has no description yet.' })
    expect(out.get('b')!.kind).toBe('thin')
  })

  it('frames the posting as untrusted data and reads the answer by position', async () => {
    const { fn, calls } = llmReturning(
      JSON.stringify({
        postings: [
          {
            id: 'p1',
            enough_detail: true,
            requirements: [
              { text: '4+ years backend', kind: 'experience', must_have: true, quote: '4+ years of backend engineering' },
              { text: 'Go or Java', kind: 'skill', must_have: true, quote: 'Strong Go or Java' },
            ],
          },
        ],
      })
    )
    const out = await extractRequirements(fn, [role('job-uuid')])
    expect(calls[0].prompt).toContain('UNTRUSTED')
    expect(calls[0].prompt).toContain('[[POSTING p1')
    expect(out.get('job-uuid')).toMatchObject({ kind: 'ok' })
  })

  it('marks a posting the model skipped, and a failed call, as failed rather than thin', async () => {
    const skipped = await extractRequirements(llmReturning(JSON.stringify({ postings: [] })).fn, [role('a')])
    expect(skipped.get('a')!.kind).toBe('failed')
    const broke = await extractRequirements(llmReturning('nope').fn, [role('a')])
    expect(broke.get('a')!.kind).toBe('failed')
  })

  it('reads four postings per call', async () => {
    const { fn, calls } = llmReturning(JSON.stringify({ postings: [] }))
    await extractRequirements(fn, ['a', 'b', 'c', 'd', 'e'].map((id) => role(id)))
    expect(calls).toHaveLength(2)
  })

  it('lets a missing key through', async () => {
    await expect(extractRequirements(llmReturning(new MissingKeyError('no key')).fn, [role('a')])).rejects.toThrow('no key')
  })
})
