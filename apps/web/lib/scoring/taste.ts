// The personal taste model: how likely a person is to want a role, learned from
// what they said about roles they were shown.
//
// There is no points formula here. Three signals each produce a probability:
//
//   embedding  a similarity vote against the roles the person liked and passed
//              on. Retired with the paid embedder; roles/want-and-order replaces the blend.
//   judge      a model's holistic read. Retired with the want judge.
//   stated     the read of the stated preferences ALONE. This is the cold-start
//              prior. It fades because its blend weight is n0 / (n0 + reactions):
//              after n0 reactions it carries half of the weight it started with,
//              and the learned signals take the rest.
//
// They are combined in logit space. Until there is enough history the weights
// are the credibility weights above, split evenly between the learned signals.
// Once there are enough reactions (MIN_FIT_REACTIONS, with both outcomes) the
// weights are fitted by regularised logistic regression on the person's own
// reactions against what Cello predicted at the time, and the fitted blend is
// used only if it beats the default on held-out reactions. Nothing is tuned by
// hand per signal; the single constant is PRIOR_STRENGTH, how many reactions
// the stated preferences are worth.

import { clampP, logLoss, logit, sigmoid } from './math'
import type { Predicted, ReactionRecord } from './types'

/** How many reactions the stated preferences are worth as evidence. */
export const PRIOR_STRENGTH = 5

/** Fewest reactions (with at least MIN_PER_CLASS of each outcome) before the blend is fitted. */
export const MIN_FIT_REACTIONS = 20
export const MIN_PER_CLASS = 5

// ---------------------------------------------------------------------------
// Blend
// ---------------------------------------------------------------------------

export interface Components {
  judge: number | null
  embedding: number | null
  stated: number | null
}

export type BlendModel =
  | { kind: 'default'; n0: number }
  | { kind: 'fitted'; bias: number; wJudge: number; wEmbedding: number; wStated: number }

/** Credibility weights for the signals that are present, summing to 1. */
export function defaultWeights(nReactions: number, present: { judge: boolean; embedding: boolean; stated: boolean }) {
  const prior = PRIOR_STRENGTH / (PRIOR_STRENGTH + nReactions)
  const wStatedRaw = present.stated ? prior : 0
  const learned = [present.judge, present.embedding].filter(Boolean).length
  const share = learned === 0 ? 0 : (1 - wStatedRaw) / learned
  const raw = { judge: present.judge ? share : 0, embedding: present.embedding ? share : 0, stated: wStatedRaw }
  const total = raw.judge + raw.embedding + raw.stated
  if (total === 0) return raw
  return { judge: raw.judge / total, embedding: raw.embedding / total, stated: raw.stated / total }
}

export function blendWant(c: Components, model: BlendModel, nReactions: number): number {
  if (model.kind === 'fitted') {
    const z =
      model.bias +
      model.wJudge * (c.judge == null ? 0 : logit(c.judge)) +
      model.wEmbedding * (c.embedding == null ? 0 : logit(c.embedding)) +
      model.wStated * (c.stated == null ? 0 : logit(c.stated))
    return clampP(sigmoid(z))
  }
  const w = defaultWeights(nReactions, {
    judge: c.judge != null,
    embedding: c.embedding != null,
    stated: c.stated != null,
  })
  const z =
    w.judge * (c.judge == null ? 0 : logit(c.judge)) +
    w.embedding * (c.embedding == null ? 0 : logit(c.embedding)) +
    w.stated * (c.stated == null ? 0 : logit(c.stated))
  return clampP(sigmoid(z))
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

interface FitRow {
  x: [number, number, number]
  y: 0 | 1
}

function toRow(p: Predicted, reaction: ReactionRecord['reaction']): FitRow {
  return {
    x: [
      p.judge == null ? 0 : logit(p.judge),
      p.embedding == null ? 0 : logit(p.embedding),
      p.stated == null ? 0 : logit(p.stated),
    ],
    y: reaction === 'not_for_me' ? 0 : 1,
  }
}

/** Solves A x = b for a small dense system by Gaussian elimination. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    ;[m[col], m[piv]] = [m[piv], m[col]]
    const d = m[col][col]
    if (Math.abs(d) < 1e-12) continue
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col] / d
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]))
}

/**
 * Ridge-regularised logistic regression by Newton steps, pulled toward `prior`
 * (the default weights) rather than toward zero, so a small history moves the
 * blend a little and a large one moves it a lot.
 */
export function fitLogistic(rows: readonly FitRow[], prior: [number, number, number, number], lambda = 1): [number, number, number, number] {
  let beta: number[] = [...prior]
  for (let iter = 0; iter < 25; iter++) {
    const grad = [0, 0, 0, 0]
    const hess = [0, 1, 2, 3].map(() => [0, 0, 0, 0])
    for (const r of rows) {
      const f = [1, r.x[0], r.x[1], r.x[2]]
      const z = f.reduce((s, v, i) => s + v * beta[i], 0)
      const p = sigmoid(z)
      const w = Math.max(p * (1 - p), 1e-6)
      for (let i = 0; i < 4; i++) {
        grad[i] += (p - r.y) * f[i]
        for (let j = 0; j < 4; j++) hess[i][j] += w * f[i] * f[j]
      }
    }
    for (let i = 0; i < 4; i++) {
      grad[i] += lambda * (beta[i] - prior[i])
      hess[i][i] += lambda
    }
    const step = solve(hess, grad)
    let move = 0
    for (let i = 0; i < 4; i++) {
      beta[i] -= step[i]
      move += Math.abs(step[i])
    }
    if (move < 1e-6) break
  }
  return [beta[0], beta[1], beta[2], beta[3]]
}

export interface FitEvidence {
  n: number
  positives: number
  /** Held-out log loss of the default blend and of the fitted one. */
  cvDefault: number | null
  cvFitted: number | null
  adopted: boolean
  reason: string
}

export interface FitResult {
  model: BlendModel
  evidence: FitEvidence
}

function rowsFrom(reactions: readonly ReactionRecord[]): FitRow[] {
  const rows: FitRow[] = []
  for (const r of reactions) {
    const p = r.predicted
    if (!p || (p.judge == null && p.embedding == null && p.stated == null)) continue
    rows.push(toRow(p, r.reaction))
  }
  return rows
}

function defaultPrior(n: number, rows: readonly FitRow[]): [number, number, number, number] {
  // Which signals were ever present in this history decides the default weights.
  const w = defaultWeights(n, {
    judge: rows.some((r) => r.x[0] !== 0),
    embedding: rows.some((r) => r.x[1] !== 0),
    stated: rows.some((r) => r.x[2] !== 0),
  })
  return [0, w.judge, w.embedding, w.stated]
}

function predictRow(beta: readonly number[], r: FitRow): number {
  return clampP(sigmoid(beta[0] + beta[1] * r.x[0] + beta[2] * r.x[1] + beta[3] * r.x[2]))
}

/**
 * Fits the blend on the person's own reactions. Refuses (keeps the default) when
 * there is not enough history, or when the fitted blend does not beat the default
 * on held-out reactions.
 */
export function fitBlend(reactions: readonly ReactionRecord[], folds = 5): FitResult {
  const rows = rowsFrom(reactions)
  const n = rows.length
  const positives = rows.filter((r) => r.y === 1).length
  const dflt: BlendModel = { kind: 'default', n0: PRIOR_STRENGTH }
  const keep = (reason: string, cvDefault: number | null = null, cvFitted: number | null = null): FitResult => ({
    model: dflt,
    evidence: { n, positives, cvDefault, cvFitted, adopted: false, reason },
  })

  if (n < MIN_FIT_REACTIONS) return keep(`needs ${MIN_FIT_REACTIONS} reactions with predictions, has ${n}`)
  if (positives < MIN_PER_CLASS || n - positives < MIN_PER_CLASS) {
    return keep(`needs at least ${MIN_PER_CLASS} of each outcome, has ${positives} interested and ${n - positives} passed`)
  }

  const predD: number[] = []
  const predF: number[] = []
  const y: number[] = []
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => i % folds !== f)
    const test = rows.filter((_, i) => i % folds === f)
    if (test.length === 0 || train.length < MIN_FIT_REACTIONS / 2) continue
    const prior = defaultPrior(train.length, train)
    const beta = fitLogistic(train, prior)
    for (const r of test) {
      predD.push(predictRow(prior, r))
      predF.push(predictRow(beta, r))
      y.push(r.y)
    }
  }
  const cvDefault = logLoss(predD, y)
  const cvFitted = logLoss(predF, y)
  // A fitted blend must be clearly better, not merely different, to replace the default.
  if (!(cvFitted < cvDefault - 0.005)) {
    return keep('the fitted blend did not beat the default on held-out reactions', cvDefault, cvFitted)
  }
  const prior = defaultPrior(n, rows)
  const [bias, wJudge, wEmbedding, wStated] = fitLogistic(rows, prior)
  return {
    model: { kind: 'fitted', bias, wJudge, wEmbedding, wStated },
    evidence: { n, positives, cvDefault, cvFitted, adopted: true, reason: 'fitted blend beat the default on held-out reactions' },
  }
}
