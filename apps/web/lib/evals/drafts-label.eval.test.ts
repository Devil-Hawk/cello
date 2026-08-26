// CI label eval for cv_tailor drafts — does the judge's groundedness score
// actually predict what the human did with the draft, and does the free
// containment check actually predict a rejection when it flags one?
//
// Same golden-fixture discipline as match-scorer.eval.test.ts: reads a
// committed fixture (lib/evals/fixtures/drafts-label.golden.json), calls no
// model and no database, and refuses to report a verdict below
// MIN_SAMPLE_PER_CLASS — see harness.ts's evaluateRanking/evaluatePrecision,
// both of which this file exercises against real inline case lists too, not
// just the fixture, so the refusal path itself stays covered even on a day
// the committed fixture is comfortably above the floor.
//
// WHY THE COMMITTED FIXTURE IS SYNTHETIC, NOT A SNAPSHOT
//   scripts/snapshot-drafts-eval-data.ts exists and is owner-run, exactly
//   like scripts/snapshot-eval-data.ts — but unlike the match scorer's
//   fixture, this one is NOT what that script produced yet: it documents a
//   real gap in lib/graph/autopilot.ts (a passing cv_tailor_draft verdict is
//   never persisted to eval_verdicts today, only fail/unjudged — see that
//   script's own header), so a live snapshot right now would return almost
//   no judged+reviewed pairs. The starter fixture here is synthetic-but-
//   realistic data so the eval mechanism itself — the ranking direction, the
//   precision computation, the floor discipline — is proven correct before
//   real data exists to grade. Regenerate with the real script once
//   autopilot.ts's gap closes.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  MIN_SAMPLE_PER_CLASS,
  evaluatePrecision,
  evaluateRanking,
  formatEvalResult,
  type LabelledCase,
} from './harness'

interface DraftLabelCase {
  id: string
  judgeScore: number
  judgeVerdict: 'pass' | 'fail'
  containmentOk: boolean
  containmentReason: string | null
  status: string
  humanAccepted: boolean
}

interface Fixture {
  note: string
  cases: DraftLabelCase[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'lib/evals/fixtures/drafts-label.golden.json'), 'utf8')
)

describe('drafts label eval — judge score vs human accept/reject', () => {
  it('the groundedness judge score separates accepted drafts from rejected ones', () => {
    const cases: LabelledCase[] = fixture.cases.map((c) => ({
      id: c.id,
      score: c.judgeScore,
      positive: c.humanAccepted,
      label: `${c.status} (judge ${c.judgeVerdict})`,
    }))
    // Looser than match-scorer's 0.7: this is one judge call's score against
    // a single human click, not an aggregate over months of behaviour — more
    // single-case noise is expected, so the bar for "carries real signal" is
    // lower without being a coin flip.
    const result = evaluateRanking('drafts-label judge/human correlation', cases, 0.65)
    console.log(formatEvalResult(result))
    expect(result.verdict, result.summary).toBe('pass')
  })

  it('refuses rather than grading on too little data', () => {
    // Inline, deliberately below MIN_SAMPLE_PER_CLASS — proves the floor
    // itself stays enforced even on a day the committed fixture is
    // comfortably above it.
    const tiny: LabelledCase[] = [
      { id: 'a', score: 0.9, positive: true },
      { id: 'b', score: 0.2, positive: false },
    ]
    const result = evaluateRanking('drafts-label judge/human correlation', tiny, 0.65)
    expect(result.verdict).toBe('insufficient-data')
    expect(result.score).toBeNull()
  })
})

describe('drafts label eval — containment precision', () => {
  it('a containment flag correctly predicts rejection most of the time', () => {
    const cases = fixture.cases.map((c) => ({ predicted: !c.containmentOk, actual: !c.humanAccepted }))
    const result = evaluatePrecision('drafts-label containment precision', cases, 0.8)
    console.log(formatEvalResult(result))
    expect(result.verdict, result.summary).toBe('pass')
  })

  it('refuses rather than grading on too few flagged drafts', () => {
    const tiny = [
      { predicted: true, actual: true },
      { predicted: true, actual: false },
      { predicted: false, actual: false },
    ]
    const result = evaluatePrecision('drafts-label containment precision', tiny, 0.8)
    expect(result.verdict).toBe('insufficient-data')
    expect(result.score).toBeNull()
    expect(3).toBeLessThan(MIN_SAMPLE_PER_CLASS) // documents WHY: too few cases, not too few flags
  })
})

describe('drafts label eval — fixture sanity', () => {
  it('every case has a resolved human decision', () => {
    // application_drafts.status is pending_review|approved|submitted|
    // rejected|failed — the snapshot script filters to reviewed_at IS NOT
    // NULL, i.e. never pending_review. Pin that here too, so a future
    // fixture edit can't silently reintroduce an undecided row.
    const decided = new Set(['approved', 'submitted', 'rejected', 'failed'])
    for (const c of fixture.cases) {
      expect(decided.has(c.status), `${c.id} has undecided status "${c.status}"`).toBe(true)
    }
  })

  it('every judge score is inside the 0-1 range autoevals returns', () => {
    for (const c of fixture.cases) {
      expect(c.judgeScore, c.id).toBeGreaterThanOrEqual(0)
      expect(c.judgeScore, c.id).toBeLessThanOrEqual(1)
    }
  })

  it('a containment flag always carries a reason; a clean pass never does', () => {
    for (const c of fixture.cases) {
      if (c.containmentOk) {
        expect(c.containmentReason, c.id).toBeNull()
      } else {
        expect(c.containmentReason, c.id).toEqual(expect.any(String))
      }
    }
  })
})
