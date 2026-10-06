// A role's strengths and gaps for one person (K17b, blueprint 4.6): code first, a model for the rest.
//
//   1. Code reads every requirement against the person's own material (lib/fit/code.ts). Free, instant, never stored.
//   2. A model step (`role.evidence`) reads what code could not settle, with quotes checked by code. Stored in
//      role_evidence, and recomputed only when the posting or the person's material changed.
//   3. The person's corrections win over both and survive every recompute.
//
// Who may run the model, and when (blueprint 5.1 and 11.3). Opening a record runs it only when this
// computer can (rung R2, no request spent), once per role while its verdicts are fresh. On free models or
// the person's own key it runs only on Check my chance. Every run counts against one daily cap, 24 roles.
// With no model the code verdicts show and the rest say "Cello needs a model to read this one".
//
// The model step stays off until the instance flag `role_evidence_live` is on (the measure S20 passes before it
// is switched on). With the flag off, or with no flag table or row at all, only code reads a role.

import { createHash } from 'node:crypto'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { modelDoor, availableRungs } from '@/lib/learning/model-door'
import type { ModelDoor } from '@/lib/models/doors.types'
import { fromReaderRequirements } from '@/lib/scoring/posting-requirements'
import { codeVerdicts } from './code'
import { EVIDENCE_STEP, runEvidenceStep } from './evidence'
import { loadMaterial, materialKey, type Material } from './material'
import { modelReadsSince, readEvidence, saveEvidence } from './store'
import type { FitItem, FitRequirement, FitStrip, FitVerdict, RoleEvidenceRow, RoleFitView } from './types'

/** Roles a model may read for one person in a day, on any rung but their own paid key. */
export const FREE_CHECKS_PER_DAY = 24

export type FitMode = 'view' | 'open' | 'check'

export interface FitDeps {
  admin: AdminClient
  userId: string
  keys?: DecryptedApiKeys
  door?: ModelDoor
  now?: () => Date
}

export interface RoleFitResult extends RoleFitView {
  /** Set when the daily cap stopped a model read that would otherwise have run. */
  limit?: 'cap'
}

/** True only when the instance has switched the model step on. Absent flag table or row: off, as `picks_live` is. */
export async function evidenceLive(admin: AdminClient): Promise<boolean> {
  try {
    const { data, error } = await admin.from('instance_flags').select('on').eq('key', 'role_evidence_live').maybeSingle()
    return !error && (data as { on?: boolean } | null)?.on === true
  } catch {
    return false
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** A requirement's id: a hash of its text, so the same requirement keeps its id when the rest of the posting changes. */
export const requirementKey = (text: string) => createHash('sha256').update(norm(text)).digest('hex').slice(0, 12)

interface LoadedRole {
  requirements: FitRequirement[]
  authorizationIds: Set<string>
  descMd5: string | null
}

/** The role's requirements from the reader's record on the posting. Null when this is not the person's role. */
export async function loadRole(admin: AdminClient, userId: string, jobId: string): Promise<LoadedRole | null> {
  const { data } = await admin.from('person_roles').select('job_id, jobs!inner(requirements, description_md5)').eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  if (!data) return null
  const raw = data as unknown as { jobs: { requirements: unknown; description_md5: string | null } | { requirements: unknown; description_md5: string | null }[] | null }
  const job = Array.isArray(raw.jobs) ? raw.jobs[0] : raw.jobs
  if (!job) return null
  const outcome = fromReaderRequirements(job.requirements ?? null)
  const requirements: FitRequirement[] = []
  const authorizationIds = new Set<string>()
  const seen = new Set<string>()
  if (outcome.kind === 'ok') {
    for (const r of outcome.requirements) {
      const id = requirementKey(r.text)
      if (seen.has(id)) continue
      seen.add(id)
      requirements.push({ id, text: r.text, skills: [], kind: r.mustHave ? 'must' : 'nice' })
      if (r.kind === 'authorization') authorizationIds.add(id)
    }
  }
  return { requirements, authorizationIds, descMd5: job.description_md5 ?? null }
}

/** The person's correction over a fresh model verdict over the code verdict. A model verdict from stale material is not used. */
export function mergeFit(reqs: readonly FitRequirement[], code: readonly FitItem[], stored: RoleEvidenceRow | null, current: { descMd5: string | null; materialKey: string }): FitItem[] {
  const fresh = Boolean(stored) && stored!.material_key === current.materialKey && stored!.desc_md5 === current.descMd5
  const byId = new Map<string, FitItem>()
  // Model verdicts first, then the person's, so a correction wins whatever order the row holds them in.
  for (const i of stored?.items ?? []) if (i.origin === 'model' && fresh) byId.set(i.requirementId, i)
  for (const i of stored?.items ?? []) if (i.origin === 'person') byId.set(i.requirementId, i)
  return reqs.map((r, n) => byId.get(r.id) ?? code[n])
}

export function stripOf(items: readonly FitItem[]): FitStrip {
  // A Not found item is unknown here: a gap only when a model or the person says so.
  const count = (v: FitVerdict) => items.filter((i) => i.verdict === v).length
  return { strengths: count('strength'), gaps: count('gap'), unknown: count('unknown') }
}

export const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()

const EMPTY: RoleFitResult = { items: [], strip: { strengths: 0, gaps: 0, unknown: 0 }, needsModel: false, readAt: null }

/**
 * One role's fit. `view` is code and what is stored. `open` also runs the model step when this computer can,
 * `check` when any model the person has can. A run happens only when something is unsettled and stale or missing.
 */
export async function readRoleFit(deps: FitDeps, jobId: string, mode: FitMode = 'view'): Promise<RoleFitResult> {
  const { admin, userId } = deps
  const role = await loadRole(admin, userId, jobId)
  if (!role) return EMPTY
  const material: Material = await loadMaterial(admin, userId)
  const key = materialKey(material)
  const code = codeVerdicts(role.requirements, material.sources, role.authorizationIds)
  const stored = await readEvidence(admin, userId, jobId)
  const current = { descMd5: role.descMd5, materialKey: key }
  let items = mergeFit(role.requirements, code, stored, current)
  let limit: 'cap' | undefined

  const unsettled = () => role.requirements.filter((r, n) => items[n].origin === 'code' && items[n].verdict === 'unknown' && !role.authorizationIds.has(r.id))
  if (mode !== 'view' && unsettled().length > 0 && deps.keys && (await evidenceLive(admin))) {
    const door = deps.door ?? modelDoor
    const rung = door.pickRung(EVIDENCE_STEP, { ceiling: 'R4', order: [], creditBought: false }, availableRungs(deps.keys), deps.keys)
    const allowed = rung.rung !== null && (mode === 'check' || rung.rung === 'R2')
    if (allowed) {
      const now = (deps.now ?? (() => new Date()))()
      const used = await modelReadsSince(admin, userId, startOfUtcDay(now))
      if (used >= FREE_CHECKS_PER_DAY) limit = 'cap'
      else {
        const todo = unsettled()
        const run = await runEvidenceStep({ userId, requirements: todo, sources: material.sources, keys: deps.keys, door })
        if (run) {
          const fresh = Boolean(stored) && stored!.material_key === key && stored!.desc_md5 === role.descMd5
          const kept = (stored?.items ?? []).filter((i) => i.origin === 'person' || (fresh && i.origin === 'model' && !todo.some((r) => r.id === i.requirementId)))
          await saveEvidence(admin, { userId, jobId, items: [...kept, ...run.items], prov: run.prov, descMd5: role.descMd5, materialKey: key, computedAt: now.toISOString() })
          items = mergeFit(role.requirements, code, await readEvidence(admin, userId, jobId), current)
        }
      }
    }
  }
  const after = (await readEvidence(admin, userId, jobId)) ?? stored
  const readAt = after && after.origin === 'model' && after.material_key === key ? after.computed_at : null
  return { items, strip: stripOf(items), needsModel: unsettled().length > 0, readAt, ...(limit ? { limit } : {}) }
}

/**
 * The person's own call on one requirement: strength, gap or unknown, with an optional note. It is stored as theirs,
 * wins over every other verdict, and survives every recompute.
 */
export async function correctEvidence(
  deps: Pick<FitDeps, 'admin' | 'userId'>,
  jobId: string,
  correction: { requirementId: string; verdict: FitVerdict; note?: string }
): Promise<FitItem | null> {
  const { admin, userId } = deps
  const role = await loadRole(admin, userId, jobId)
  const req = role?.requirements.find((r) => r.id === correction.requirementId)
  if (!role || !req) return null
  const material = await loadMaterial(admin, userId)
  const key = materialKey(material)
  const stored = await readEvidence(admin, userId, jobId)
  const fresh = Boolean(stored) && stored!.material_key === key && stored!.desc_md5 === role.descMd5
  const item: FitItem = { requirementId: req.id, requirement: req.text, verdict: correction.verdict, evidence: [], origin: 'person', ...(correction.note?.trim() ? { note: correction.note.trim().slice(0, 300) } : {}) }
  // Stale model verdicts are dropped here, so confirming the key below never revives them.
  const kept = (stored?.items ?? []).filter((i) => i.requirementId !== req.id && (i.origin === 'person' || (fresh && i.origin === 'model')))
  await saveEvidence(admin, { userId, jobId, items: [...kept, item], prov: fresh ? (stored?.prov ?? null) : null, descMd5: role.descMd5, materialKey: key, computedAt: fresh ? stored?.computed_at : undefined })
  return item
}
