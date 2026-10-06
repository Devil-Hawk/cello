// Deciding which roles to show, in two stages that share one pass:
//
//   assessRoles    hard constraints remove roles the person ruled out, each with
//                  its reason; the taste model scores what is left (similarity
//                  vote, holistic judge, and the stated preferences as the fading
//                  prior), blended per the person's own history; the roles most
//                  likely to be wanted get a chance check against the resume.
//   buildShortlist assessRoles on the day's candidates, then the list is chosen by
//                  want then chance, with one labelled exploration pick, and each
//                  pick gets its one sentence.
//
// The same code runs in production (Supabase store, the person's own model key)
// and in the offline evaluation (in-memory store, free models).
//
// Job vectors are computed for the pass and thrown away: a 2048-number vector per
// posting would not fit the free database, and the similarity only needs them
// while the pass runs. The vectors of reactions are kept, because those are the
// training data.

import { createHash } from 'node:crypto'
import { scoreTitleAgainstTargets, parseTitle } from '@/lib/matching/title-rank'
import type { LlmRunner } from '@/lib/harness/types'
import { assessChances } from './chance'
import { checkConstraints, type StatedConstraints } from './constraints'
import { entropy } from './math'
import { NOT_READ_YET } from './posting-requirements'
import { chooseShortlist, toPicks, type Rankable } from './shortlist'
import type { AssessmentToStore, ScoringStore } from './store'
import { blendWant, chooseTau, fitBlend, kernelWant, toExamples, type BlendModel } from './taste'
import type { Assessment, BlockReason, ChanceResult, ReactionRecord, RoleFacts, ShortlistPick, WantResult } from './types'
import { judgeStated, judgeWant, renderStated, type StatedPreferences, type WantJudgement } from './want-judge'

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

export interface AssessRequest {
  userId: string
  resumeText: string
  stated: StatedPreferences
  constraints: StatedConstraints
  /** Open roles to assess. */
  candidates: RoleFacts[]
  /** How many roles the judge reads. */
  judgePool?: number
  /** How many get a chance check. 0 skips the chance check. */
  chanceFor?: number
  /** False when the person turned `taste:blend` off (or mem0 could not be read): no reaction orders anything, the code order stands. Default on. */
  taste?: boolean
}

export interface AssessResult {
  /** Every role that was judged, with its want and, for the likeliest, its chance. */
  assessed: Assessment[]
  blocked: { jobId: string; reasons: BlockReason[] }[]
  taste: { nReactions: number; fitted: boolean; reason: string }
  notes: string[]
  /** Judged roles that also have a chance: what the shortlist is chosen from. */
  rankables: Rankable[]
}

export interface ShortlistRequest extends AssessRequest {
  forDate: string
  size?: number
  exploreCount?: number
}

export interface ShortlistResult extends AssessResult {
  picks: ShortlistPick[]
}

export function roleText(r: RoleFacts): string {
  return `${r.title}\n${r.company}\n${r.location ?? ''}\n${(r.description ?? '').slice(0, 1500)}`
}

/** Short stable fingerprint, to tell whether an earlier read used the same stated preferences or resume. */
export function keyOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

const EMBED_BATCH = 48
/** The roles with the least certain want that still get a chance check, so the exploration pick has evidence. */
const UNCERTAIN_EXTRA = 4

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

export async function assessRoles(deps: PipelineDeps, req: AssessRequest): Promise<AssessResult> {
  const { llm, embed, store } = deps
  const rng = deps.rng ?? Math.random
  const notes: string[] = []
  const judgePool = req.judgePool ?? 32
  const chanceFor = req.chanceFor ?? 12

  // 1. Hard constraints.
  const blocked: AssessResult['blocked'] = []
  const eligible: RoleFacts[] = []
  for (const role of req.candidates) {
    const reasons = checkConstraints(role, req.constraints)
    if (reasons.length > 0) blocked.push({ jobId: role.id, reasons })
    else eligible.push(role)
  }

  // 2. Taste. Refit the blend on the person's own history first. With taste off the reactions
  // are not read at all and the cached fit is left as it was.
  const taste = req.taste !== false
  let reactions = taste ? await store.reactions(req.userId) : []
  const fit = fitBlend(reactions)
  if (taste) await store.saveTaste(req.userId, { model: fit.model, evidence: fit.evidence }, { n: fit.evidence.n, positive: fit.evidence.positives })
  const blend: BlendModel = fit.model

  // Vectors for the candidates (kept only for this pass) and for any reaction that has none for this model yet.
  const roleVec = new Map<string, number[]>()
  const embedModel = embed ? embed.model : null
  if (embed && taste && eligible.length + reactions.length > 0) {
    try {
      const missingReactions = reactions.filter((r) => r.embeddingModel !== embed.model || !r.embedding)
      const vectors = await embedAll(embed, [...eligible.map(roleText), ...missingReactions.map((r) => r.text)])
      if (vectors && vectors.length > 0) {
        eligible.forEach((r, i) => roleVec.set(r.id, vectors[i]))
        if (missingReactions.length > 0) {
          await store.setReactionEmbeddings(
            req.userId,
            missingReactions.map((r, i) => ({ id: r.id, embedding: vectors[eligible.length + i], model: embed.model }))
          )
          reactions = await store.reactions(req.userId)
        }
      } else if (!vectors) {
        notes.push('Taste similarity was skipped: no embedding provider answered.')
      }
    } catch (err) {
      notes.push(`Taste similarity was skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (taste && !embed) {
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

  // 3. The judge reads a pool of roles, given the person's own decisions.
  const pool = retrievePool(eligible, pEmbedding, req.stated, judgePool, rng)
  const judged = await judgeWant(llm, { stated: req.stated, reactions, roles: pool })
  const nReactions = reactions.length

  // The stated preferences alone are the cold-start prior. With no decisions yet the
  // judge above already saw nothing else, so its answer is the stated read. After
  // that the read is made once per role and kept, because it does not change as
  // reactions arrive.
  const statedKey = keyOf(renderStated(req.stated))
  const resumeKey = keyOf(req.resumeText)
  const prior = await store.priorAssessments(req.userId, pool.map((r) => r.id))
  const statedP = new Map<string, number>()
  if (nReactions === 0) {
    for (const [id, j] of judged) statedP.set(id, j.p)
  } else {
    const missing: RoleFacts[] = []
    for (const role of pool) {
      const p = prior.get(role.id)
      if (p && p.statedKey === statedKey && p.statedP != null) statedP.set(role.id, p.statedP)
      else missing.push(role)
    }
    if (missing.length > 0) for (const [id, j] of await judgeStated(llm, req.stated, missing)) statedP.set(id, j.p)
  }

  const wantById = new Map<string, { p: number; reason: string; components: WantResult['components'] }>()
  for (const role of pool) {
    const j: WantJudgement | undefined = judged.get(role.id)
    const emb = pEmbedding.get(role.id) ?? null
    const stated = statedP.get(role.id) ?? null
    if (!j && emb == null && stated == null) continue
    const components = { judge: j?.p ?? null, embedding: emb, stated }
    wantById.set(role.id, { p: blendWant(components, blend, nReactions), reason: j?.reason ?? '', components })
  }
  const calibrated = blend.kind === 'fitted'

  // 4. Chance for the roles most likely to be wanted, plus the most uncertain ones for exploration.
  const ranked = [...wantById.entries()].sort((a, b) => b[1].p - a[1].p)
  const forChance = new Set<string>()
  if (chanceFor > 0) {
    ranked.slice(0, chanceFor).forEach(([id]) => forChance.add(id))
    ranked
      .slice(chanceFor)
      .sort((a, b) => entropy(b[1].p) - entropy(a[1].p))
      .slice(0, UNCERTAIN_EXTRA)
      .forEach(([id]) => forChance.add(id))
  }
  const chanceRoles = pool.filter((r) => forChance.has(r.id))
  const chances = new Map<string, ChanceResult>()
  const toCheck: RoleFacts[] = []
  for (const role of chanceRoles) {
    const p = prior.get(role.id)
    // A settled label for this resume is kept; one that failed or could not be read is tried again.
    if (p?.chance && p.chance.chance !== 'cannot_assess' && p.resumeKey === resumeKey) chances.set(role.id, p.chance)
    else toCheck.push(role)
  }
  if (toCheck.length > 0) {
    // What each posting asks for was read once by the posting reader and is only looked up here: nothing in this pass reads a posting.
    const outcomes = await store.requirements(req.userId, toCheck.map((r) => r.id))
    const fresh = await assessChances(
      llm,
      req.resumeText,
      toCheck.map((role) => ({ role, outcome: outcomes.get(role.id) ?? { kind: 'thin' as const, reason: NOT_READ_YET } }))
    )
    for (const [id, c] of fresh) chances.set(id, c)
  }

  // 5. What the shortlist chooses from.
  const rankables: Rankable[] = []
  for (const role of chanceRoles) {
    const w = wantById.get(role.id)
    const c = chances.get(role.id)
    if (!w || !c) continue
    rankables.push({ jobId: role.id, p: w.p, reason: w.reason, chance: c.chance, gaps: c.gaps })
  }

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
    ...assessed.map((a) => ({ ...a, wantReason: a.want?.reason ?? null, stated: { p: a.want?.components.stated ?? null, key: statedKey }, resumeKey: a.chance ? resumeKey : null })),
    ...blocked.map((b) => ({ jobId: b.jobId, blocked: true, blockedReasons: b.reasons, want: null, chance: null, wantReason: null, stated: null, resumeKey: null })),
  ]
  await store.saveAssessments(req.userId, rows)
  return { assessed, blocked, taste: { nReactions, fitted: calibrated, reason: fit.evidence.reason }, notes, rankables }
}

export async function buildShortlist(deps: PipelineDeps, req: ShortlistRequest): Promise<ShortlistResult> {
  const result = await assessRoles(deps, req)
  const picks = toPicks(chooseShortlist(result.rankables, { size: req.size ?? 6, exploreCount: req.exploreCount }))
  await deps.store.saveShortlist(req.userId, req.forDate, picks)
  if (picks.length === 0) result.notes.push('Nothing cleared the constraints and the judge this time.')
  return { ...result, picks }
}
