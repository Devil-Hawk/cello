// Eval for findInventedFacts() (lib/resume/import/llm.ts) — the containment
// check that stops an LLM resume reformat from quietly acquiring an employer,
// a degree, a date or a metric the candidate never wrote. That check goes out
// under the user's name to an employer, so it gets its own regression suite
// rather than living only among llm.test.ts's unit tests.
//
// Free and deterministic: reads a committed fixture of hand-built attack
// pairs (lib/evals/fixtures/fabrication.golden.json), calls the real
// findInventedFacts(), calls no model and no database.
//
// TWO KNOWN GAPS ARE COMMITTED ON PURPOSE, NOT FIXED HERE.
//   Two fixture cases are marked `knownGap: true`: a fabricated employer
//   placed on a Markdown heading line (bodyProse() drops every heading line
//   before the scan, since headings are structure we asked the model to add
//   — but nothing stops a model from hiding a lie there instead of in bold
//   text), and an inflated headcount spelled out in words ("twelve" instead
//   of "12" — HARD_FACT_RE only matches digits or capitalised tokens, so a
//   spelled-out number is invisible to it). This file does not own llm.ts and
//   does not weaken either case to force a green run: they are asserted with
//   `it.fails`, vitest's marker for "expected to currently fail". That keeps
//   the gap visible in the test list forever instead of silently deleted,
//   and — because `it.fails` itself fails if the wrapped test starts passing
//   — the day someone closes either gap in llm.ts, THIS file goes red until
//   the fixture's `knownGap` flag is removed, rather than the fix going
//   unnoticed.
//
// PRECISION OVER RECALL, ON PURPOSE.
//   findInventedFacts's own docstring says it is "deliberately biased toward
//   false POSITIVES": a wrongly-flagged reformat only costs the user the
//   deterministic layout, but a missed fabrication costs them the job. This
//   suite's hard gate reflects that asymmetry — every non-gap case must match
//   exactly, so precision and recall over the non-gap set are both 1.0 — and
//   reports precision/recall over the FULL set (gaps included) as the honest,
//   uncomfortable number rather than rounding it away.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatEvalResult, type EvalResult } from './harness'
import { findInventedFacts } from '../resume/import/llm'

interface FabricationCase {
  name: string
  source: string
  output: string
  shouldFlag: boolean
  why: string
  /** True for a case this suite has confirmed the guard currently misses.
   *  Asserted with `it.fails` below — see the file header for why. */
  knownGap?: boolean
}

interface Fixture {
  note: string
  cases: FabricationCase[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'lib/evals/fixtures/fabrication.golden.json'), 'utf8')
)

const liveCases = fixture.cases.filter((c) => !c.knownGap)
const gapCases = fixture.cases.filter((c) => c.knownGap)

describe('findInventedFacts — regression over the committed attack fixture', () => {
  it.each(liveCases.map((c): [string, FabricationCase] => [c.name, c]))(
    '%s',
    (_name, c) => {
      const invented = findInventedFacts(c.source, c.output)
      const flagged = invented.length > 0
      expect(flagged, `${c.why}\ngot invented=${JSON.stringify(invented)}`).toBe(c.shouldFlag)
    }
  )

  // `it.fails` inverts the usual contract: the body must fail for this test
  // to pass. If a body here starts succeeding, `it.fails` itself fails —
  // which is exactly the "gap closed, update the fixture" signal described
  // in the file header.
  describe.each(gapCases.map((c): [string, FabricationCase] => [c.name, c]))('known gap: %s', (_name, c) => {
    it('is a documented gap — the guard returns nothing today (see fixture `why`)', () => {
      const invented = findInventedFacts(c.source, c.output)
      // Pins the CURRENT, WRONG value rather than using `it.fails`.
      //
      // `it.fails` was the first shape here, and it is too loose: it passes
      // whenever the body throws for ANY reason. If findInventedFacts ever
      // started throwing on this input, the gap test would stay green and the
      // "someone closed this gap" signal the file header promises would never
      // fire. Asserting the exact return value means a fix, a regression, AND
      // a throw all turn this red — which is the whole point of tracking a
      // known gap in the suite instead of deleting the case.
      expect(invented).toEqual([])
    })
  })
})

describe('findInventedFacts — precision and recall over the whole fixture', () => {
  it('reports honestly, including the two documented gaps', () => {
    let truePos = 0
    let falsePos = 0
    let falseNeg = 0
    let trueNeg = 0
    for (const c of fixture.cases) {
      const flagged = findInventedFacts(c.source, c.output).length > 0
      if (c.shouldFlag && flagged) truePos++
      else if (!c.shouldFlag && flagged) falsePos++
      else if (c.shouldFlag && !flagged) falseNeg++
      else trueNeg++
    }

    const precision = truePos + falsePos === 0 ? 1 : truePos / (truePos + falsePos)
    const recall = truePos + falseNeg === 0 ? 1 : truePos / (truePos + falseNeg)

    // Not one of harness.ts's ranking evals (there is no score to threshold,
    // only a boolean) — built by hand in the same shape so it prints and
    // reads the same way a CI failure from match-scorer.eval.test.ts does.
    const result: EvalResult = {
      name: 'fabrication guard precision/recall',
      verdict: falsePos === 0 && falseNeg === gapCases.length ? 'pass' : 'fail',
      score: recall,
      threshold: 1,
      n: fixture.cases.length,
      summary:
        `precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)} over ${fixture.cases.length} cases ` +
        `(${truePos} TP, ${falsePos} FP, ${falseNeg} FN incl. ${gapCases.length} documented gap(s), ${trueNeg} TN).`,
    }
    console.log(formatEvalResult(result))

    // Precision is the non-negotiable one: a real fact must NEVER be flagged,
    // or the guard trains the user to click past its own warning (see the
    // top-of-file comment on findInventedFacts). Zero tolerance, no fixture
    // exceptions.
    expect(falsePos, result.summary).toBe(0)
    // Recall is 1.0 on everything this suite does not already know the guard
    // misses. The moment a gap case is fixed, `it.fails` above turns red
    // before this number quietly gets better — so this assertion staying at
    // exactly `gapCases.length` is itself a check that the fixture's gap
    // bookkeeping hasn't drifted from reality.
    expect(falseNeg, result.summary).toBe(gapCases.length)
  })
})
