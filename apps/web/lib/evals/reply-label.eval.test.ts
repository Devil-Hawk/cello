// CI label eval for outreach replies — does the outreach groundedness judge
// score actually predict a positive reply? Scaffolded exactly like
// drafts-label.eval.test.ts (same golden-fixture discipline, same harness
// functions), but this one is EXPECTED to refuse today: see the fixture's
// own note. outreach_messages.replied_at/reply_classification are brand new
// columns with one writer (lib/gmail/stage.ts) that only fires on a real
// inbound Gmail reply — there is no seed data and nothing to backfill.
//
// The refusal below is the actual assertion this test makes, not a
// placeholder for one: it proves the eval mechanism reads the fixture,
// computes real numbers, and still reports insufficient-data honestly rather
// than manufacturing a verdict from four rows. The day
// scripts/snapshot-reply-eval-data.ts has real data past MIN_SAMPLE_PER_CLASS,
// this test goes red on the `toBeLessThan(MIN_SAMPLE_PER_CLASS)` line — the
// exact same automatic promotion mechanism match-scorer.eval.test.ts uses —
// and the fixture gets regenerated for real, at which point this becomes a
// hard regression gate with no code change needed.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MIN_SAMPLE_PER_CLASS, evaluateRanking, formatEvalResult, type LabelledCase } from './harness'
import type { ReplyClassification } from '../outreach/types'

interface ReplyLabelCase {
  id: string
  judgeScore: number
  replyClassification: ReplyClassification
}

interface Fixture {
  note: string
  cases: ReplyLabelCase[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'lib/evals/fixtures/reply-label.golden.json'), 'utf8')
)

describe('reply label eval — judge score vs positive reply', () => {
  it('reports honestly rather than grading on too little real reply data', () => {
    const cases: LabelledCase[] = fixture.cases.map((c) => ({
      id: c.id,
      score: c.judgeScore,
      // "positive" is the actual reward signal (design doc's "reward loops
      // with LLM-as-judge") — neutral/negative/bounce are all NOT the
      // outcome outreach is optimising for, same binary collapse
      // match-scorer applies to stage/notes.
      positive: c.replyClassification === 'positive',
      label: c.replyClassification,
    }))
    const result = evaluateRanking('reply-label judge/reply correlation', cases, 0.65)
    console.log(formatEvalResult(result))

    if (result.verdict === 'insufficient-data') {
      expect(result.score).toBeNull()
      expect(result.summary).toContain('Not enough labelled data')
      // The gate that lets this become a real assertion later, automatically
      // — see this file's header.
      const positives = fixture.cases.filter((c) => c.replyClassification === 'positive').length
      const negatives = fixture.cases.length - positives
      expect(Math.min(positives, negatives)).toBeLessThan(MIN_SAMPLE_PER_CLASS)
      return
    }

    expect(result.verdict, result.summary).toBe('pass')
  })
})

describe('reply label eval — fixture sanity', () => {
  it('every classification is one of the four the reply_classification CHECK constraint allows', () => {
    const allowed: ReplyClassification[] = ['positive', 'neutral', 'negative', 'bounce']
    for (const c of fixture.cases) {
      expect(allowed, c.id).toContain(c.replyClassification)
    }
  })

  it('every judge score is inside the 0-1 range autoevals returns', () => {
    for (const c of fixture.cases) {
      expect(c.judgeScore, c.id).toBeGreaterThanOrEqual(0)
      expect(c.judgeScore, c.id).toBeLessThanOrEqual(1)
    }
  })
})
