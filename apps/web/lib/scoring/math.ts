// Small numeric helpers shared by the taste model and its tests.

const EPS = 1e-6

export function clampP(p: number): number {
  return Math.min(1 - EPS, Math.max(EPS, p))
}

export function logit(p: number): number {
  const q = clampP(p)
  return Math.log(q / (1 - q))
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

/** Mean negative log likelihood of binary outcomes under predicted probabilities. */
export function logLoss(pred: readonly number[], y: readonly number[]): number {
  if (pred.length === 0) return 0
  let s = 0
  for (let i = 0; i < pred.length; i++) {
    const p = clampP(pred[i])
    s += y[i] === 1 ? -Math.log(p) : -Math.log(1 - p)
  }
  return s / pred.length
}

/** Binary entropy in nats; highest at p = 0.5. */
export function entropy(p: number): number {
  const q = clampP(p)
  return -(q * Math.log(q) + (1 - q) * Math.log(1 - q))
}
