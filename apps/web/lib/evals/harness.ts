// Eval primitives: scoring a model's behaviour against labelled data, with an
// explicit refusal to report a verdict on too little of it.
//
// WHY EVALS EXIST HERE
//   Cello's product IS model output. The match score decides which ~189 of
//   11,370 jobs the user ever sees; the resume rewrite is what an employer
//   reads; the outreach draft goes to a named human. Until now every prompt
//   change was a blind change to the thing the product is — there was no way to
//   tell whether an edit made scoring better or worse. The app was already
//   asking for this out loud: lib/strategy/proposals.ts renders "Re-examine
//   what the matcher rewards — the current scores are not separating repliers
//   from non-repliers" to the user.
//
// WHY FIXTURES AND NOT LIVE QUERIES
//   Evals that hit the database are slow, non-deterministic and unavailable in
//   CI. Instead the labelled set is SNAPSHOT to a committed golden file
//   (scripts/snapshot-eval-data.ts) and the evals run against that. Free,
//   deterministic, reviewable in a diff, and a change in the data is a visible
//   commit rather than a mystery failure.
//
// WHY A MINIMUM SAMPLE
//   The first time this was pointed at real data, 16 of the 17 "applications"
//   were demo rows seeded by picking the highest-scoring jobs — a ranking eval
//   over that would have reported an excellent number that measured nothing but
//   how the seed was written. Refusing to report below a floor is the same
//   discipline lib/strategy already enforces on user-facing rates, and it is
//   the difference between an eval and a vanity metric.

/** One labelled example: a thing the model scored, plus the ground truth. */
export interface LabelledCase {
  id: string
  /** What the model produced (0-100 for the match scorer). */
  score: number
  /** Ground truth: did the human actually act on this? */
  positive: boolean
  /** Free-form context, carried so a failure names something a human recognises. */
  label?: string
}

export type EvalVerdict = 'pass' | 'fail' | 'insufficient-data'

export interface EvalResult {
  name: string
  verdict: EvalVerdict
  /** 0-1. Null when the verdict is insufficient-data — a score computed from
   *  too few examples is worse than no score, because it gets quoted. */
  score: number | null
  threshold: number
  /** Sample size the score was computed from. */
  n: number
  /** One sentence a human can act on. Always populated, including on refusal. */
  summary: string
}

/**
 * Minimum positives AND negatives before a discrimination metric means
 * anything. Ten is not a statistical claim — it is the point below which a
 * single unusual example moves the number more than a real regression would.
 */
export const MIN_SAMPLE_PER_CLASS = 10

/**
 * Probability that a randomly chosen positive outranks a randomly chosen
 * negative — the AUC of the ROC curve, computed directly rather than via
 * trapezoids so ties are handled explicitly.
 *
 * 0.5 is a coin flip: the score carries no information about the label. 1.0 is
 * perfect separation. Ties count as half, which is the standard treatment and
 * matters here because match scores are integers and collide often.
 *
 * AUC rather than accuracy because there is no threshold to pick: the question
 * is "does this scorer RANK the right things higher", which is exactly what the
 * product does with the number (sort by best match).
 */
export function rankingAuc(cases: LabelledCase[]): { auc: number; positives: number; negatives: number } {
  const pos = cases.filter((c) => c.positive)
  const neg = cases.filter((c) => !c.positive)
  if (pos.length === 0 || neg.length === 0) {
    return { auc: 0.5, positives: pos.length, negatives: neg.length }
  }

  let wins = 0
  for (const p of pos) {
    for (const n of neg) {
      if (p.score > n.score) wins += 1
      else if (p.score === n.score) wins += 0.5
    }
  }
  return { auc: wins / (pos.length * neg.length), positives: pos.length, negatives: neg.length }
}

/**
 * Run the ranking eval, refusing to grade when either class is too small.
 *
 * The refusal is the feature. It returns a real result object with the sample
 * sizes so the caller can print WHY there is no verdict — silence would read as
 * "nothing to report" rather than "not enough evidence to report anything".
 */
export function evaluateRanking(
  name: string,
  cases: LabelledCase[],
  threshold: number
): EvalResult {
  const { auc, positives, negatives } = rankingAuc(cases)

  if (positives < MIN_SAMPLE_PER_CLASS || negatives < MIN_SAMPLE_PER_CLASS) {
    return {
      name,
      verdict: 'insufficient-data',
      score: null,
      threshold,
      n: cases.length,
      summary:
        `Not enough labelled data to judge: ${positives} positive and ${negatives} negative ` +
        `example(s), need ${MIN_SAMPLE_PER_CLASS} of each. No verdict — a number from this ` +
        `little would get quoted and would be noise.`,
    }
  }

  const pass = auc >= threshold
  return {
    name,
    verdict: pass ? 'pass' : 'fail',
    score: auc,
    threshold,
    n: cases.length,
    summary: pass
      ? `AUC ${auc.toFixed(3)} over ${positives} positives / ${negatives} negatives (threshold ${threshold}).`
      : `AUC ${auc.toFixed(3)} is below the ${threshold} threshold over ${positives} positives / ` +
        `${negatives} negatives — the score is not separating what the user acts on from what they ignore.`,
  }
}

/**
 * Shannon entropy of a score distribution, bucketed into deciles, normalised to
 * 0-1.
 *
 * Answers a question that needs no behavioural labels at all and is therefore
 * meaningful from day one: is the scorer actually discriminating, or is it
 * piling everything into one band? A scorer that rates every job 60 is
 * perfectly useless and perfectly stable — no ranking metric would catch that
 * on its own, and it is a realistic failure mode for a rubric that drifts.
 *
 * 0 means every job landed in one decile. 1 means they are spread evenly.
 */
export function scoreSpread(scores: number[]): number {
  if (scores.length === 0) return 0
  const buckets = new Array(10).fill(0)
  for (const s of scores) {
    const clamped = Math.max(0, Math.min(99, s))
    buckets[Math.floor(clamped / 10)] += 1
  }
  const total = scores.length
  let entropy = 0
  for (const count of buckets) {
    if (count === 0) continue
    const p = count / total
    entropy -= p * Math.log2(p)
  }
  // log2(10) is the maximum entropy for 10 buckets.
  return entropy / Math.log2(10)
}

/** Format a result the way a human reads a CI failure: verdict, then why. */
export function formatEvalResult(r: EvalResult): string {
  const mark = r.verdict === 'pass' ? 'PASS' : r.verdict === 'fail' ? 'FAIL' : 'SKIP'
  return `[${mark}] ${r.name} — ${r.summary}`
}
