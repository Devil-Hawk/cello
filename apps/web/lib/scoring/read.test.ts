import { describe, expect, it } from 'vitest'
import { FIT_COLUMNS, FIT_EMBED, chanceLabel, firstGapCopy, fitHighlights, fitRowOf, fitToColumns, parseFit } from './read'

describe('parseFit', () => {
  it('gives an unassessed role no want and no chance', () => {
    const fit = parseFit({ id: 'j1', assessed_at: null, blocked_reasons: [], want_p: null, want_reason: null, want_detail: null, chance: null, chance_detail: null })
    expect(fit).toEqual({ jobId: 'j1', assessedAt: null, blocked: [], want: null, chance: null })
    expect(chanceLabel(fit.chance)).toBe('Not assessed yet')
  })

  it('survives a row with none of the columns at all', () => {
    expect(parseFit({}).want).toBeNull()
    expect(parseFit({ blocked_reasons: 'x', chance_detail: [1, 2] }).blocked).toEqual([])
  })

  it('reads the stated reasons, the want band and the cited chance', () => {
    const fit = parseFit({
      id: 'j2',
      assessed_at: '2026-10-06T08:00:00Z',
      blocked_reasons: [{ kind: 'location', text: 'It is based in Germany, and you said you work in the United States.' }, { nope: 1 }],
      want_p: 0.71,
      want_reason: ' Payments work like the Stripe role you applied to. ',
      want_detail: { calibrated: true, nReactions: 23 },
      chance: 'possible',
      chance_detail: {
        checks: [{ requirement: '4+ years backend', mustHave: true, status: 'met', evidence: { line: 3, quote: 'Backend engineer, Brightpay, 2020-2024' } }, { requirement: 'Kubernetes', mustHave: false, status: 'not_met', evidence: null }],
        gaps: ['Nice to have: Kubernetes'],
        confirm: ['Authorized to work in the US'],
        note: '1 of 1 required items are shown on your resume.',
      },
    })
    expect(fit.blocked).toHaveLength(1)
    expect(fit.want).toEqual({ p: 0.71, reason: 'Payments work like the Stripe role you applied to.', tier: 'high', calibrated: true, nReactions: 23 })
    expect(fit.chance!.label).toBe('possible')
    expect(fit.chance!.checks[0].evidence).toEqual({ line: 3, quote: 'Backend engineer, Brightpay, 2020-2024' })
    expect(fit.chance!.confirm).toEqual(['Authorized to work in the US'])
    expect(chanceLabel(fit.chance)).toBe('Possible')
  })

  it('shows Not assessed yet for a posting that could not be read', () => {
    expect(chanceLabel('cannot_assess')).toBe('Not assessed yet')
    expect(chanceLabel('strong')).toBe('Strong')
    expect(chanceLabel('stretch')).toBe('Stretch')
  })
})

describe('the person_roles embed', () => {
  const verdict = { assessed_at: '2026-10-06T08:00:00Z', blocked_reasons: [], want_p: 0.6, want_reason: 'Fits.', want_detail: null, chance: 'strong', chance_detail: { checks: [] } }

  it('reads an embed object, an embed array and a bare verdict row alike', () => {
    expect(parseFit({ id: 'j1', person_roles: verdict }).chance?.label).toBe('strong')
    expect(parseFit({ id: 'j1', person_roles: [verdict] }).chance?.label).toBe('strong')
    expect(parseFit({ id: 'j1', ...verdict }).chance?.label).toBe('strong')
    expect(parseFit({ id: 'j1', person_roles: [] }).chance).toBeNull()
    expect(parseFit({ id: 'j1', person_roles: null }).want).toBeNull()
  })

  it('maps assessed_at to assessedAt and keeps the job id from the outer row', () => {
    const fit = parseFit({ id: 'j9', person_roles: verdict })
    expect(fit.assessedAt).toBe('2026-10-06T08:00:00Z')
    expect(fit.jobId).toBe('j9')
    expect(fitRowOf({ person_roles: [verdict] })).toBe(verdict)
  })

  it('writes a verdict back into the columns of the embed', () => {
    const cols = fitToColumns(parseFit({ id: 'j9', person_roles: verdict }))
    expect(cols.assessed_at).toBe('2026-10-06T08:00:00Z')
    expect(cols.chance).toBe('strong')
    expect(Object.keys(cols)).not.toContain('fit_assessed_at')
  })

  it('embeds the person row as an inner join', () => {
    expect(FIT_EMBED).toBe(`person_roles!inner(${FIT_COLUMNS})`)
  })
})

describe('fitHighlights', () => {
  it('returns only the requirements the resume shows, each with its line', () => {
    const detail = {
      checks: [
        { requirement: 'Go', mustHave: true, status: 'met', evidence: { line: 3, quote: 'built payment services in Go' } },
        { requirement: 'Years', mustHave: true, status: 'partial', evidence: { line: 4, quote: 'Java services' } },
        { requirement: 'Rust', mustHave: true, status: 'not_met', evidence: null },
      ],
    }
    expect(fitHighlights(detail)).toEqual(['Go: built payment services in Go'])
    expect(fitHighlights(null)).toEqual([])
  })
})

describe('copy helpers', () => {
  it('phrases the first real gap for a tooltip', () => {
    const fit = parseFit({ chance: 'possible', chance_detail: { gaps: ['Nice to have: Rust', 'Only partly shown: fraud detection'] } })
    expect(firstGapCopy(fit)).toBe('Not clearly on your resume: fraud detection.')
    const fit2 = parseFit({ chance: 'possible', chance_detail: { gaps: ['Only partly shown: fraud detection'] } })
    expect(firstGapCopy(fit2)).toBe('Not clearly on your resume: fraud detection.')
  })

  it('lists the verdict columns to select', () => {
    expect(FIT_COLUMNS).toContain('want_p')
    expect(FIT_COLUMNS).not.toContain('match_score')
  })
})
