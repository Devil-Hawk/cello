// Measurements for the shortlist evaluation. Pure functions, covered by metrics.test.ts.

/** Deterministic random numbers, so a split or a shuffle is the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Splits items into a stream and a held-out set, keeping each group (here, the
 * job function) in both in the same proportion. The held-out set is never shown
 * to the person, so what is measured on it is what was learned, not remembered.
 */
export function stratifiedSplit<T>(items: readonly T[], groupOf: (t: T) => string, heldOutShare: number, rng: () => number): { stream: T[]; heldOut: T[] } {
  const groups = new Map<string, T[]>()
  for (const it of items) {
    const g = groupOf(it)
    groups.set(g, [...(groups.get(g) ?? []), it])
  }
  const stream: T[] = []
  const heldOut: T[] = []
  let carry = 0
  for (const g of [...groups.keys()].sort()) {
    const members = shuffled(groups.get(g)!, rng)
    const exact = members.length * heldOutShare + carry
    const n = Math.min(members.length, Math.round(exact))
    carry = exact - n
    heldOut.push(...members.slice(0, n))
    stream.push(...members.slice(n))
  }
  return { stream, heldOut }
}

/** Share of the top k of a ranking that the person actually wanted. */
export function precisionAtK(rankedIds: readonly string[], positives: ReadonlySet<string>, k = 5): number {
  const top = rankedIds.slice(0, k)
  return top.length === 0 ? 0 : top.filter((id) => positives.has(id)).length / top.length
}

/** Mean squared error of probabilities against 0/1 outcomes. Lower is better; 0.25 is "always say 50%". */
export function brier(pred: readonly number[], y: readonly number[]): number {
  if (pred.length === 0) return NaN
  let s = 0
  for (let i = 0; i < pred.length; i++) s += (pred[i] - y[i]) ** 2
  return s / pred.length
}

/** Area under the ROC curve: the chance that a random wanted role is ranked above a random unwanted one. */
export function auc(scores: readonly number[], y: readonly number[]): number {
  let wins = 0
  let pairs = 0
  for (let i = 0; i < scores.length; i++) {
    if (y[i] !== 1) continue
    for (let j = 0; j < scores.length; j++) {
      if (y[j] !== 0) continue
      pairs++
      wins += scores[i] > scores[j] ? 1 : scores[i] === scores[j] ? 0.5 : 0
    }
  }
  return pairs === 0 ? NaN : wins / pairs
}

export function agreement<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return NaN
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return same / a.length
}

/** Cohen's kappa: agreement beyond what the two labelers' own label frequencies would produce by luck. */
export function cohenKappa<T>(a: readonly T[], b: readonly T[]): number {
  const n = a.length
  if (n === 0) return NaN
  const po = agreement(a, b)
  const labels = new Set<T>([...a, ...b])
  let pe = 0
  for (const l of labels) {
    const pa = a.filter((x) => x === l).length / n
    const pb = b.filter((x) => x === l).length / n
    pe += pa * pb
  }
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}

export function mean(xs: readonly number[]): number {
  const v = xs.filter((x) => Number.isFinite(x))
  return v.length === 0 ? NaN : v.reduce((s, x) => s + x, 0) / v.length
}

export function round(x: number, d = 3): number {
  return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x
}
