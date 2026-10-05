// Scoring for the ingestion evals. Pure: runs in, numbers out, so the arithmetic
// is tested without a model (score.test.ts).

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// --- careers page reader -----------------------------------------------------

export interface PageCase {
  id: string
  kind: string
  /** Titles a correct reader finds; null when the page has no postings. */
  truth: string[] | null
  forbidden?: string[]
}

export interface PageRun {
  caseId: string
  /** The model's text parsed into an answer of the expected shape. */
  valid: boolean
  /** Items the model named, before the page checked them. */
  returned: number
  /** Titles that survived the page check. */
  kept: string[]
  dropped: number
}

export interface PageScore {
  pages: number
  validJson: number
  /** Of the titles kept after the page check, the share that are real. Null when nothing was kept. */
  precision: number | null
  /** Of the real titles on listing pages, the share found. */
  recall: number | null
  negatives: { passed: number; total: number }
  forbiddenKept: number
  /** Items the page check threw away, over items the model named. */
  hallucinationRate: number | null
  returned: number
  kept: number
}

const ratio = (n: number, d: number): number | null => (d > 0 ? Number((n / d).toFixed(3)) : null)

export function scorePages(cases: PageCase[], runs: PageRun[]): PageScore {
  const byId = new Map(cases.map((c) => [c.id, c]))
  let keptTotal = 0
  let keptCorrect = 0
  let truthTotal = 0
  let truthFound = 0
  let negPassed = 0
  let negTotal = 0
  let forbiddenKept = 0
  let returned = 0
  let dropped = 0
  let valid = 0

  for (const run of runs) {
    const c = byId.get(run.caseId)
    if (!c) continue
    if (run.valid) valid++
    returned += run.returned
    dropped += run.dropped
    keptTotal += run.kept.length
    const truth = new Set((c.truth ?? []).map(norm))
    keptCorrect += run.kept.filter((t) => truth.has(norm(t))).length
    forbiddenKept += run.kept.filter((t) => (c.forbidden ?? []).some((f) => norm(f) === norm(t))).length
    if (c.truth === null) {
      negTotal++
      if (run.kept.length === 0) negPassed++
    } else if (c.truth.length > 0) {
      const got = new Set(run.kept.map(norm))
      truthTotal += truth.size
      truthFound += [...truth].filter((t) => got.has(t)).length
    }
  }
  return {
    pages: runs.length,
    validJson: ratio(valid, runs.length) ?? 0,
    precision: ratio(keptCorrect, keptTotal),
    recall: ratio(truthFound, truthTotal),
    negatives: { passed: negPassed, total: negTotal },
    forbiddenKept,
    hallucinationRate: ratio(dropped, returned),
    returned,
    kept: keptTotal,
  }
}

// --- requirements ------------------------------------------------------------

export interface ReqRun {
  caseId: string
  kind: 'prose' | 'blurb'
  valid: boolean
  /** Items the model named in both lists. */
  returned: number
  /** Items that survived grounding in the posting. */
  keptMust: string[]
  keptNice: string[]
  /** The judge's verdict on the kept items, when it was asked. */
  judge?: { yes: number; total: number }
}

export interface ReqScore {
  postings: number
  validJson: number
  /** Items that are words the posting contains, over items named. */
  groundedRate: number | null
  /** Of the grounded items, the share the judge says the posting asks for, in the right list. */
  judgePrecision: number | null
  blurbsEmpty: { passed: number; total: number }
  returned: number
  kept: number
}

export function scoreRequirements(runs: ReqRun[]): ReqScore {
  let returned = 0
  let kept = 0
  let valid = 0
  let yes = 0
  let judged = 0
  let blurbPassed = 0
  let blurbTotal = 0
  for (const r of runs) {
    if (r.valid) valid++
    const k = r.keptMust.length + r.keptNice.length
    returned += r.returned
    kept += k
    if (r.judge) {
      yes += r.judge.yes
      judged += r.judge.total
    }
    if (r.kind === 'blurb') {
      // The prompt's job is to answer an empty list for a posting that asks for nothing,
      // so this counts what the model said, not what survived grounding.
      blurbTotal++
      if (r.returned === 0) blurbPassed++
    }
  }
  return {
    postings: runs.length,
    validJson: ratio(valid, runs.length) ?? 0,
    groundedRate: ratio(kept, returned),
    judgePrecision: ratio(yes, judged),
    blurbsEmpty: { passed: blurbPassed, total: blurbTotal },
    returned,
    kept,
  }
}
