// The daily shortlist, end to end:
//
//   1. hard constraints remove roles the person ruled out, each with its reason;
//   2. the taste model scores what is left (similarity vote, holistic judge, and
//      the stated preferences as the fading prior), blended per the person's own
//      history;
//   3. the roles most likely to be wanted get a chance check against the resume;
//   4. the list is chosen by want then chance, with one labelled exploration pick,
//      and each pick gets its one sentence.
//
// The same code runs in production (Supabase store, the person's own model key)
// and in the offline evaluation (in-memory store, free models).

import { scoreTitleAgainstTargets, parseTitle } from '@/lib/matching/title-rank'
import type { LlmRunner } from '@/lib/harness/types'
import { assessChances } from './chance'
import { checkConstraints, type StatedConstraints } from './constraints'
import { entropy } from './math'
import { extractRequirements, type RequirementsOutcome } from './requirements'
import { chooseShortlist, toPicks, type Rankable } from './shortlist'
import type { AssessmentToStore, ScoringStore } from './store'
import { blendWant, chooseTau, fitBlend, kernelWant, toExamples, type BlendModel } from './taste'
import type { Assessment, BlockReason, ChanceResult, ReactionRecord, RoleFacts, ShortlistPick, WantResult } from './types'
import { judgeWant, type StatedPreferences, type WantJudgement } from './want-judge'

/** Embeds texts with one fixed model. `embed` returns null when no provider is reachable right now. */
export interface Embedder {
  model: string
  embed(texts: string[]): Promise<number[][] | null>
}

export interface PipelineDeps {
  llm: LlmRunner
  embed: Embedder | null
  store: ScoringStore
  /** Randomness for the retrieval fill. Seed it in tests. */
  rng?: () => number
}

export interface ShortlistRequest {
  userId: string
  resumeText: string
  stated: StatedPreferences
  constraints: StatedConstraints
  /** Open roles the person has not reacted to yet. */
  candidates: RoleFacts[]
  forDate: string
  size?: number
  exploreCount?: number
  /** How many roles the judge reads. */
  judgePool?: number
  /** How many get a chance check. */
  chanceFor?: number
}

export interface ShortlistResult {
  picks: ShortlistPick[]
  /** Every role that was judged, with its want and chance. */
  assessed: Assessment[]
  blocked: { jobId: string; reasons: BlockReason[] }[]
  taste: { nReactions: number; fitted: boolean; reason: string }
  notes: string[]
}

export function roleText(r: RoleFacts): string {
  return `${r.title}\n${r.company}\n${r.location ?? ''}\n${(r.description ?? '').slice(0, 1500)}`
}

const EMBED_BATCH = 48

async function embedAll(embedder: Embedder, texts: string[]): Promise<number[][] | null> {
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const r = await embedder.embed(texts.slice(i, i + EMBED_BATCH))
    if (!r) return null
    vectors.push(...r)
  }
  return vectors
}

function shuffle<T>(a: readonly T[], rng: () => number): T[] {
  const out = [...a]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Which roles the judge reads. A recall step, not a score: part of the pool is the
 * roles the taste similarity likes best, part is the best title matches to what
 * the person stated, and the rest is a random draw so roles unlike anything they
 * have seen still get a look.
 */
export function retrievePool(
  eligible: readonly RoleFacts[],
  pEmbedding: ReadonlyMap<string, number>,
  stated: StatedPreferences,
  size: number,
  rng: () => number
): RoleFacts[] {
  if (eligible.length <= size) return [...eligible]
  const chosen = new Map<string, RoleFacts>()
  const take = (roles: RoleFacts[], n: number) => {
    for (const r of roles) {
      if (chosen.size >= size || n <= 0) break
      if (!chosen.has(r.id)) {
        chosen.set(r.id, r)
        n--
      }
    }
  }
  const quota = Math.max(1, Math.ceil(size * 0.4))
  take(
    eligible.filter((r) => pEmbedding.has(r.id)).sort((a, b) => (pEmbedding.get(b.id) ?? 0) - (pEmbedding.get(a.id) ?? 0)),
    quota
  )
  const targets = stated.titles.map((t) => parseTitle(t))
  if (targets.length > 0) {
    take(
      eligible
        .map((r) => ({ r, s: scoreTitleAgainstTargets(r.title, targets).score }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r),
      quota
    )
  }
  take(shuffle(eligible, rng), size)
  return [...chosen.values()]
}

export async function buildShortlist(deps: PipelineDeps, req: ShortlistRequest): Promise<ShortlistResult> {
  const { llm, embed, store } = deps
  const rng = deps.rng ?? Math.random
  const notes: string[] = []
  const size = req.size ?? 6
  const judgePool = req.judgePool ?? 32
  const chanceFor = req.chanceFor ?? 12

  // 1. Hard constraints.
  const blocked: ShortlistResult['blocked'] = []
  const eligible: RoleFacts[] = []
  for (const role of req.candidates) {
    const reasons = checkConstraints(role, req.constraints)
    if (reasons.length > 0) blocked.push({ jobId: role.id, reasons })
    else eligible.push(role)
  }

  // 2. Taste. Refit the blend on the person's own history first.
  let reactions = await store.reactions(req.userId)
  const fit = fitBlend(reactions)
  await store.saveTaste(req.userId, { model: fit.model, evidence: fit.evidence }, { n: fit.evidence.n, positive: fit.evidence.positives })
  const blend: BlendModel = fit.model

  // Vectors for the candidates and for any reaction that has none for this model yet.
  const roleVec = new Map<string, number[]>()
  const embedModel = embed ? embed.model : null
  if (embed) {
    try {
      const have = await store.embeddings(req.userId, eligible.map((r) => r.id), embed.model)
      for (const [id, v] of have) roleVec.set(id, v)
      const missingRoles = eligible.filter((r) => !have.has(r.id))
      const missingReactions = reactions.filter((r) => r.embeddingModel !== embed.model || !r.embedding)
      const vectors = await embedAll(embed, [...missingRoles.map(roleText), ...missingReactions.map((r) => r.text)])
      if (vectors && vectors.length > 0) {
        const fresh = new Map<string, number[]>()
        missingRoles.forEach((r, i) => fresh.set(r.id, vectors[i]))
        await store.saveEmbeddings(req.userId, embed.model, fresh)
        for (const [id, v] of fresh) roleVec.set(id, v)
        await store.setReactionEmbeddings(
          req.userId,
          missingReactions.map((r, i) => ({ id: r.id, embedding: vectors[missingRoles.length + i], model: embed.model }))
        )
        reactions = await store.reactions(req.userId)
      } else if (!vectors) {
        notes.push('Taste similarity was skipped: no embedding provider answered.')
      }
    } catch (err) {
      notes.push(`Taste similarity was skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    notes.push('No embedding provider is configured, so taste similarity was skipped.')
  }

  const usable: ReactionRecord[] = embedModel ? reactions.filter((r) => r.embeddingModel === embedModel) : []
  const examples = toExamples(usable)
  const tau = chooseTau(examples)
  const pEmbedding = new Map<string, number>()
  for (const role of eligible) {
    const v = roleVec.get(role.id)
    const p = v ? kernelWant(v, examples, tau) : null
    if (p != null) pEmbedding.set(role.id, p)
  }

  // 3. The judge reads a pool of roles.
  const pool = retrievePool(eligible, pEmbedding, req.stated, judgePool, rng)
  const judged = await judgeWant(llm, { stated: req.stated, reactions, roles: pool })

  const nReactions = reactions.length
  const wantById = new Map<string, { p: number; reason: string; components: WantResult['components'] }>()
  for (const role of pool) {
    const j: WantJudgement | undefined = judged.get(role.id)
    const emb = pEmbedding.get(role.id) ?? null
    if (!j && emb == null) continue
    const components = { judge: j?.p ?? null, embedding: emb, stated: j?.statedP ?? null }
    wantById.set(role.id, { p: blendWant(components, blend, nReactions), reason: j?.reason ?? '', components })
  }
  const calibrated = blend.kind === 'fitted'

  // 4. Chance for the roles most likely to be wanted, plus the most uncertain ones for exploration.
  const ranked = [...wantById.entries()].sort((a, b) => b[1].p - a[1].p)
  const forChance = new Set(ranked.slice(0, chanceFor).map(([id]) => id))
  ranked
    .slice(chanceFor)
    .sort((a, b) => entropy(b[1].p) - entropy(a[1].p))
    .slice(0, 4)
    .forEach(([id]) => forChance.add(id))
  const chanceRoles = pool.filter((r) => forChance.has(r.id))
  const cached = await store.requirements(req.userId, chanceRoles.map((r) => r.id))
  const toRead = chanceRoles.filter((r) => !cached.has(r.id))
  const read = toRead.length > 0 ? await extractRequirements(llm, toRead) : new Map<string, RequirementsOutcome>()
  await store.saveRequirements(req.userId, read)
  const outcomes = new Map<string, RequirementsOutcome>([...cached, ...read])
  const chances: Map<string, ChanceResult> = await assessChances(
    llm,
    req.resumeText,
    chanceRoles.map((role) => ({ role, outcome: outcomes.get(role.id) ?? { kind: 'failed' as const, reason: 'not read' } }))
  )

  // 5. Choose the list.
  const rankables: Rankable[] = []
  for (const role of chanceRoles) {
    const w = wantById.get(role.id)
    const c = chances.get(role.id)
    if (!w || !c) continue
    rankables.push({ jobId: role.id, p: w.p, reason: w.reason, chance: c.chance, gaps: c.gaps })
  }
  const picks = toPicks(chooseShortlist(rankables, { size, exploreCount: req.exploreCount }))

  // 6. Persist what was concluded.
  const assessed: Assessment[] = pool
    .filter((r) => wantById.has(r.id))
    .map((r) => {
      const w = wantById.get(r.id)!
      return {
        jobId: r.id,
        blocked: false,
        blockedReasons: [],
        want: { p: w.p, reason: w.reason, calibrated, components: w.components, nReactions },
        chance: chances.get(r.id) ?? null,
      }
    })
  const rows: AssessmentToStore[] = [
    ...assessed.map((a) => ({ ...a, wantReason: a.want?.reason ?? null })),
    ...blocked.map((b) => ({ jobId: b.jobId, blocked: true, blockedReasons: b.reasons, want: null, chance: null, wantReason: null })),
  ]
  await store.saveAssessments(req.userId, rows)
  await store.saveShortlist(req.userId, req.forDate, picks)

  if (picks.length === 0) notes.push('Nothing cleared the constraints and the judge this time.')
  return { picks, assessed, blocked, taste: { nReactions, fitted: calibrated, reason: fit.evidence.reason }, notes }
}
