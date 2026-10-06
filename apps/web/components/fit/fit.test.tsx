// The words and states of the three shared fit components. Rendered with
// react-dom/server (no DOM is configured for vitest), which is enough for the
// copy a person reads: a chip that is a word never a number, a panel that cites a
// resume line for every met requirement, a triage control with the right buttons.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ChanceChip } from './chance-chip'
import { FitPanel } from './fit-panel'
import { TriageControl } from './triage-control'
import type { RoleFit } from '@/lib/scoring/types'

const FIT: RoleFit = {
  jobId: 'j1',
  assessedAt: '2026-10-06T08:00:00Z',
  blocked: [],
  want: { p: 0.8, reason: 'Payments work like the Stripe role you applied to.', tier: 'high', calibrated: false, nReactions: 4 },
  chance: {
    label: 'possible',
    checks: [
      { requirement: '4+ years of backend engineering', mustHave: true, status: 'met', evidence: { line: 3, quote: 'Backend engineer, Brightpay, 2020-2024' } },
      { requirement: 'fraud detection', mustHave: true, status: 'not_met', evidence: null },
      { requirement: 'Go', mustHave: true, status: 'partial', evidence: { line: 4, quote: 'Java services' } },
    ],
    gaps: ['fraud detection'],
    confirm: ['Authorized to work in the US'],
    note: null,
  },
}

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

describe('ChanceChip', () => {
  it('is a word, never a number, for every state', () => {
    for (const label of ['strong', 'possible', 'stretch', 'cannot_assess'] as const) {
      const out = html(createElement(ChanceChip, { fit: { ...FIT, chance: { ...FIT.chance!, label } } }))
      expect(out).not.toMatch(/\d+\s*%/)
      expect(out).toMatch(label === 'cannot_assess' ? /Not assessed yet/ : new RegExp(label, 'i'))
    }
    expect(html(createElement(ChanceChip, { fit: null }))).toContain('Not assessed yet')
  })

  it('says why on hover: a fixed line for Strong, the first gap otherwise', () => {
    expect(html(createElement(ChanceChip, { fit: { ...FIT, chance: { ...FIT.chance!, label: 'strong' } } }))).toContain('Your resume shows everything it asks for.')
    expect(html(createElement(ChanceChip, { fit: FIT }))).toContain('Not clearly on your resume: fraud detection.')
  })
})

describe('FitPanel', () => {
  it('shows why they might want it, the cited line for each met requirement, the gaps and what to confirm', () => {
    const out = html(createElement(FitPanel, { fit: FIT }))
    expect(out).toContain('Why you might want it')
    expect(out).toContain('Payments work like the Stripe role you applied to.')
    expect(out).toContain('Your chances: Possible')
    expect(out).toContain('Backend engineer, Brightpay, 2020-2024')
    expect(out).toContain('line 3')
    expect(out).toContain('Not on your resume: fraud detection')
    expect(out).toContain('Only partly shown: Go')
    expect(out).toContain('Confirm yourself: authorized to work in the US')
  })

  it('says a posting with no requirements cannot be checked yet', () => {
    const out = html(createElement(FitPanel, { fit: { ...FIT, chance: { label: 'cannot_assess', checks: [], gaps: [], confirm: [], note: 'x' } } }))
    expect(out).toContain('The posting does not list requirements yet, so Cello cannot check your chances.')
  })

  it('offers to check an unassessed role, or says why it cannot', () => {
    expect(html(createElement(FitPanel, { fit: null, onAssess: () => undefined }))).toContain('Check my chances')
    expect(html(createElement(FitPanel, { fit: null, assessDisabledReason: 'Add your resume so Cello can check your chances.' }))).toContain('Add your resume so Cello can check your chances.')
  })

  it('shows the stated fact a filtered role breaks, and a way to change it', () => {
    const out = html(createElement(FitPanel, { fit: { ...FIT, blocked: [{ kind: 'location', text: 'It is based in Germany, and you said you work in the United States.' }], want: null, chance: null } }))
    expect(out).toContain('Filtered out')
    expect(out).toContain('It is based in Germany, and you said you work in the United States.')
    expect(out).toContain('Change dealbreakers')
  })
})

describe('TriageControl', () => {
  it('offers Interested and Not for me, with Applied in the overflow', () => {
    const out = html(createElement(TriageControl, { jobId: 'j1', surface: 'today' }))
    expect(out).toContain('Interested')
    expect(out).toContain('Not for me')
    expect(out).toContain('More ways to respond')
  })

  it('marks what the person already said', () => {
    const out = html(createElement(TriageControl, { jobId: 'j1', surface: 'roles', reaction: { reaction: 'interested' } }))
    expect(out).toMatch(/aria-pressed="true"[^>]*>(<svg[^>]*>.*?<\/svg>)?Interested/)
  })

  it('uses no engineering words and no exclamation marks', () => {
    const out = html(createElement(TriageControl, { jobId: 'j1', surface: 'today' })) + html(createElement(FitPanel, { fit: FIT })) + html(createElement(ChanceChip, { fit: FIT }))
    expect(out).not.toMatch(/\b(run|thread|tick|step|graph|agent)\b/i)
    expect(out).not.toContain('!')
    expect(out).not.toContain('\u2014')
  })
})
