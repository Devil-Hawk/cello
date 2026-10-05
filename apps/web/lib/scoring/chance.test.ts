import { describe, expect, it, vi } from 'vitest'
import type { LlmResult, LlmRunOptions } from '@/lib/harness/types'
import { MissingKeyError } from '@/lib/harness/llm'
import { assessChances, labelChance, resumeLines, verifyChecks, type CitationStats } from './chance'
import type { Requirement, RequirementsOutcome } from './requirements'
import type { RequirementCheck, RoleFacts } from './types'

const RESUME = `Jane Doe
Backend engineer, Brightpay, 2020-2024: built payment services in Go handling 2M requests per day
Backend engineer, Loop, 2018-2020: Java services, on-call rotation

Skills: Go, Java, PostgreSQL, AWS`

const lines = resumeLines(RESUME)

function req(id: string, text: string, mustHave = true, kind: Requirement['kind'] = 'skill'): Requirement {
  return { id, text, kind, mustHave, quote: text }
}

function chk(status: RequirementCheck['status'], mustHave = true, text = 'x'): RequirementCheck {
  return { requirement: text, mustHave, status, evidence: status === 'met' || status === 'partial' ? { line: 1, quote: 'q' } : null }
}

describe('resumeLines', () => {
  it('numbers non-empty lines from 1', () => {
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3, 4])
    expect(lines[1].text).toContain('Brightpay')
  })
  it('is empty for no resume', () => {
    expect(resumeLines(null)).toEqual([])
  })
})

describe('verifyChecks', () => {
  const reqs = [req('r1', '4+ years backend', true, 'experience'), req('r2', 'Strong Go'), req('r3', 'Kubernetes', false)]
  const id = (r: Requirement) => r.id

  it('counts the citations claimed and the ones that held up, for the evaluation', () => {
    const stats: CitationStats = { claimed: 0, kept: 0 }
    const reqs = [req('r1', 'Strong Go or Java'), req('r2', 'Rust')]
    verifyChecks([{ id: 'r1', status: 'met', line: 2, quote: 'built payment services in Go' }, { id: 'r2', status: 'met', line: 2, quote: 'wrote a Rust compiler' }], reqs, lines, (r) => r.id, stats)
    expect(stats).toEqual({ claimed: 2, kept: 1 })
  })
  it('keeps a citation whose quote is on the cited line', () => {
    const out = verifyChecks([{ id: 'r2', status: 'met', line: 2, quote: 'built payment services in Go' }], reqs, lines, id)
    expect(out[1]).toMatchObject({ status: 'met', evidence: { line: 2, quote: 'built payment services in Go' } })
  })

  it('throws away a citation whose quote is not on that line', () => {
    const out = verifyChecks([{ id: 'r2', status: 'met', line: 3, quote: 'built payment services in Go' }], reqs, lines, id)
    expect(out[1]).toMatchObject({ status: 'not_met', evidence: null })
  })

  it('throws away a citation to a line that does not exist or with no quote', () => {
    expect(verifyChecks([{ id: 'r2', status: 'met', line: 99, quote: 'Go' }], reqs, lines, id)[1].status).toBe('not_met')
    expect(verifyChecks([{ id: 'r2', status: 'partial', line: 2, quote: '' }], reqs, lines, id)[1].status).toBe('not_met')
  })

  it('leaves a requirement the model skipped as unclear and an unknown status as not met', () => {
    const out = verifyChecks([{ id: 'r2', status: 'banana', line: 2, quote: 'Go' }], reqs, lines, id)
    expect(out[0].status).toBe('unclear')
    expect(out[1].status).toBe('not_met')
  })

  it('does not credit a requirement the model marked not met even with a line', () => {
    const out = verifyChecks([{ id: 'r3', status: 'not_met', line: 4, quote: 'Skills: Go, Java' }], reqs, lines, id)
    expect(out[2]).toMatchObject({ status: 'not_met', evidence: null })
  })
})

describe('labelChance', () => {
  const reqs = [req('r1', 'a', true, 'skill'), req('r2', 'b', true, 'skill'), req('r3', 'c', true, 'skill'), req('r4', 'd', true, 'skill')]
  const label = (statuses: RequirementCheck['status'][], rs: Requirement[] = reqs) =>
    labelChance(rs, statuses.map((s, i) => ({ ...chk(s, true, rs[i].text) })))

  it('is Strong when every must-have is shown', () => {
    expect(label(['met', 'met', 'met', 'met']).chance).toBe('strong')
  })

  it('tolerates one partly shown item per four and no more', () => {
    expect(label(['met', 'met', 'met', 'partial']).chance).toBe('strong')
    expect(label(['met', 'met', 'partial', 'partial']).chance).toBe('possible')
  })

  it('is Possible with one missing skill and names it', () => {
    const r = label(['met', 'met', 'met', 'not_met'])
    expect(r.chance).toBe('possible')
    expect(r.gaps).toEqual(['d'])
  })

  it('is a Stretch when two required items are missing', () => {
    expect(label(['met', 'met', 'not_met', 'not_met']).chance).toBe('stretch')
  })

  it('is a Stretch when the one missing item is years of experience or a licence', () => {
    const rs = [req('r1', 'a', true, 'experience'), req('r2', 'b'), req('r3', 'c')]
    expect(labelChance(rs, [chk('not_met', true, 'a'), chk('met', true, 'b'), chk('met', true, 'c')]).chance).toBe('stretch')
  })

  it('does not let a missing nice-to-have lower the label but still lists it', () => {
    const rs = [req('r1', 'a'), req('r2', 'b'), req('r3', 'k', false)]
    const r = labelChance(rs, [chk('met', true, 'a'), chk('met', true, 'b'), chk('not_met', false, 'k')])
    expect(r.chance).toBe('strong')
    expect(r.gaps).toEqual(['Nice to have: k'])
  })

  it('lists partly shown items as gaps', () => {
    expect(label(['met', 'met', 'partial', 'partial']).gaps).toEqual(['Only partly shown: c', 'Only partly shown: d'])
  })

  it('cannot assess when a third or more of the checks went unanswered', () => {
    expect(label(['met', 'unclear', 'unclear', 'met']).chance).toBe('cannot_assess')
    expect(labelChance([], []).chance).toBe('cannot_assess')
  })

  it('keeps Strong when the resume is silent on work authorization and lists it to confirm', () => {
    const rs = [req('r1', 'a'), req('r2', 'b'), req('r3', 'Authorized to work in the US', true, 'authorization')]
    const r = labelChance(rs, [chk('met', true, 'a'), chk('met', true, 'b'), chk('not_met', true, 'Authorized to work in the US')])
    expect(r.chance).toBe('strong')
    expect(r.confirm).toEqual(['Authorized to work in the US'])
    expect(r.gaps).toEqual([])
    expect(r.note).toBe('2 of 2 required items are shown on your resume.')
  })

  it('cannot assess a posting whose only requirement is a condition to confirm', () => {
    const rs = [req('r1', 'Must be located in the US', true, 'authorization')]
    const r = labelChance(rs, [chk('not_met', true, 'Must be located in the US')])
    expect(r.chance).toBe('cannot_assess')
    expect(r.confirm).toEqual(['Must be located in the US'])
  })

  it('says how many required items are shown', () => {
    expect(label(['met', 'met', 'met', 'not_met']).note).toBe('3 of 4 required items are shown on your resume.')
  })
})

describe('assessChances', () => {
  const role = (id: string): RoleFacts => ({ id, title: 'Backend Engineer', company: 'Acme', location: null, description: 'x' })
  const ok = (rs: Requirement[]): RequirementsOutcome => ({ kind: 'ok', requirements: rs })
  const reqs = [req('r1', '4+ years backend', true, 'experience'), req('r2', 'Strong Go')]

  function llmReturning(content: string | Error) {
    const calls: LlmRunOptions[] = []
    const fn = vi.fn(async (opts: LlmRunOptions): Promise<LlmResult> => {
      calls.push(opts)
      if (content instanceof Error) throw content
      return { content, tokensUsed: 1, promptTokens: 1, completionTokens: 0, model: 'm' }
    })
    return { fn, calls }
  }

  it('answers without a model call when the posting is thin, unreadable or the resume is missing', async () => {
    const { fn } = llmReturning('{}')
    const res = await assessChances(fn, RESUME, [
      { role: role('thin'), outcome: { kind: 'thin', reason: 'The posting has no description yet.' } },
      { role: role('bad'), outcome: { kind: 'failed', reason: 'x' } },
    ])
    expect(fn).not.toHaveBeenCalled()
    expect(res.get('thin')).toMatchObject({ chance: 'cannot_assess', checks: [] })
    expect(res.get('thin')!.note).toContain('Cannot assess yet')
    expect(res.get('bad')!.chance).toBe('cannot_assess')
    const none = await assessChances(fn, '', [{ role: role('a'), outcome: ok(reqs) }])
    expect(none.get('a')!.note).toContain('Add your resume')
  })

  it('labels from verified citations and puts the resume in the system prompt', async () => {
    const { fn, calls } = llmReturning(
      JSON.stringify({
        checks: [
          { id: 'j1.r1', status: 'met', line: 2, quote: 'Backend engineer, Brightpay, 2020-2024' },
          { id: 'j1.r2', status: 'met', line: 2, quote: 'built payment services in Go' },
        ],
      })
    )
    const res = await assessChances(fn, RESUME, [{ role: role('a'), outcome: ok(reqs) }])
    expect(res.get('a')).toMatchObject({ chance: 'strong' })
    expect(res.get('a')!.checks[0].evidence).toEqual({ line: 2, quote: 'Backend engineer, Brightpay, 2020-2024' })
    expect(calls[0].system).toContain('[2] Backend engineer, Brightpay')
    expect(calls[0].prompt).not.toContain('Brightpay')
  })

  it('downgrades a requirement whose cited quote is invented', async () => {
    const { fn } = llmReturning(
      JSON.stringify({
        checks: [
          { id: 'j1.r1', status: 'met', line: 2, quote: 'ten years leading a staff team' },
          { id: 'j1.r2', status: 'met', line: 2, quote: 'built payment services in Go' },
        ],
      })
    )
    const res = await assessChances(fn, RESUME, [{ role: role('a'), outcome: ok(reqs) }])
    expect(res.get('a')!.chance).toBe('stretch')
    expect(res.get('a')!.gaps).toContain('4+ years backend')
  })

  it('marks the roles of a failed call as cannot assess and does not throw', async () => {
    const { fn } = llmReturning('not json')
    const res = await assessChances(fn, RESUME, [{ role: role('a'), outcome: ok(reqs) }])
    expect(res.get('a')!.chance).toBe('cannot_assess')
  })

  it('lets a missing key through to the caller', async () => {
    const { fn } = llmReturning(new MissingKeyError('no key'))
    await expect(assessChances(fn, RESUME, [{ role: role('a'), outcome: ok(reqs) }])).rejects.toThrow('no key')
  })

  it('checks three roles in one call', async () => {
    const { fn, calls } = llmReturning(JSON.stringify({ checks: [] }))
    await assessChances(fn, RESUME, ['a', 'b', 'c', 'd'].map((id) => ({ role: role(id), outcome: ok(reqs) })))
    expect(calls).toHaveLength(2)
  })
})
