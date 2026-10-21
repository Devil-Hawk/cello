// roles/judge: what a kept role asks for, read against the person's resume.
//
//   requirements  code first: the items of jobs.requirements (parser version 2, each with the posting's own words). A posting
//                 with no list at all goes once to the role.requirements step; its items are kept only when the quote is
//                 verbatim in the posting (groundModelAnswer). A posting that still has fewer than two items is thin: band
//                 cannot_assess, reason no_requirements, no model call.
//   evidence      the role.evidence step, three roles to a call: the resume as numbered lines, one reading per requirement
//                 (met, partial or not met, with a line and a quote). verifyChecks keeps met or partial only when the quote is
//                 on the cited line, else the reading is not met. Work authorization and place items are never read: they are
//                 marked confirm and never move the band.
//   band          labelChance, the rule anyone can read. Written with the readings, the provenance and judged_at.
//
// Every model call goes through the free door (./free-door): this file never names a model.
//
// The legacy chance and chance_detail columns are written beside band until the pages read band (PR 6).

import { z } from 'zod'
import { MODEL_LIMIT, type ModelCall } from '@/lib/ingest/model'
import { ownedJobsQuery } from '@/lib/jobs/owned-query'
import type { RequirementItem } from '@/lib/jobs/relevance-types'
import { ModelAnswerSchema, parseRequirements, RequirementsSchema, type Requirements } from '@/lib/jobs/requirements'
import { completeRequirements } from '@/lib/jobs/requirements-model'
import type { AdminClient, LlmRunner } from '@/lib/harness/types'
import type { Evidence, Prov } from '@/lib/provenance/types'
import { getBaseResume } from '@/lib/resume/store'
import { assessChances, ChanceStop } from '@/lib/scoring/chance'
import { MIN_REQUIREMENTS, TOO_FEW, type Requirement } from '@/lib/scoring/posting-requirements'
import type { Chance, ChanceResult, RequirementCheck } from '@/lib/scoring/types'
import { judgeCall, realDoor, shareFor, type DoorDeps } from './free-door'

export interface Reading {
  id: string
  text: string
  kind: RequirementItem['kind']
  status: RequirementCheck['status']
  line: number | null
  quote: string | null
  /** Where the reading was made: 'resume v7'. */
  source: string
  /** Work authorization or place: Cello does not read it, the person confirms it. */
  confirm?: true
}

export interface JudgeDeps {
  door?: DoorDeps
  now?: () => Date
}

export type Stopped = 'minute' | 'day' | 'no_model' | 'no_resume'
export interface JudgeOutcome {
  /** Roles that now carry a band. */
  judged: string[]
  /** Why the rest were left waiting, when something stopped the run. */
  stopped: Stopped | null
}

export const NO_REQUIREMENTS_LINE = 'The posting does not list requirements, so Cello cannot check your chances.'
const ROLES_PER_CALL = 3
const MAX_REQUIREMENTS = 12
const WAITING_WINDOW = 300

/** Work authorization, clearance and where the person must be: facts only the person can state. */
const CONFIRM =
  /\b(?:authori[sz]ed to work|work authori[sz]ation|right to work|eligible to work|work permit|visa|sponsorship|security clearance|(?:must|should|need to) (?:be )?(?:located|based|reside|live)|reside in|relocat\w*|on-?site|in[- ]office|hybrid)\b/i
const CREDENTIAL = /\b(?:certifi\w*|licen[cs]e\w*)\b/i

const ChecksAnswer = z.object({ checks: z.array(z.object({ id: z.string() }).passthrough()) })

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

interface Prepared {
  scored: { item: RequirementItem; requirement: Requirement }[]
  confirm: RequirementItem[]
}

/** The items to read (must first, at most twelve) and the items the person confirms. */
export function prepare(req: Requirements): Prepared {
  const all = req.items ?? []
  const scored: Prepared['scored'] = []
  const confirm: RequirementItem[] = []
  for (const item of [...all.filter((i) => i.kind === 'must'), ...all.filter((i) => i.kind !== 'must')]) {
    if (item.visa || item.clearance || CONFIRM.test(item.text)) confirm.push(item)
    else if (scored.length < MAX_REQUIREMENTS) {
      const kind = item.years?.min ? 'experience' : item.degree ? 'education' : CREDENTIAL.test(item.text) ? 'credential' : 'skill'
      scored.push({ item, requirement: { id: `r${scored.length + 1}`, text: item.text, kind, mustHave: item.kind === 'must', quote: item.quote, origin: item.origin } })
    }
  }
  if (confirm.length === 0 && req.visa.sponsorship === 'not_offered') {
    const text = 'Work authorization without sponsorship'
    confirm.push({ id: 'visa', text, kind: 'must', heading: '', quote: req.visa.evidence ?? text, skills: [], years: null, degree: null, visa: 'not_offered', clearance: null, origin: 'code', prov: { rule: 'visa sentence' } })
  }
  return { scored, confirm }
}

interface JobRow {
  id: string
  title: string
  description: string | null
  description_md: string | null
  location: string | null
  salary_range: string | null
  requirements: unknown
  viewer_company_name: string | null
}

/**
 * The role's requirements record, completed by the role.requirements step when the posting has no list at all and no model
 * has read it yet. Stores the completed record on the shared job (the posting reader's own column). `stop` is set when the
 * door refused, and the role is then left waiting.
 */
async function requirementsOf(db: AdminClient, userId: string, job: JobRow, deps: JudgeDeps): Promise<{ req: Requirements; stop: Stopped | null }> {
  const now = deps.now ?? (() => new Date())
  const stored = RequirementsSchema.safeParse(job.requirements)
  const current = stored.success && stored.data.version === 2
  const description = job.description ?? ''
  const base: Requirements = current ? stored.data : parseRequirements({ title: job.title, description, descriptionMd: job.description_md, location: job.location, salaryRange: job.salary_range })
  let req = base
  let stop: Stopped | null = null
  if (!base.items?.length && !base.model_checked_at) {
    let prov: Prov | null = null
    const call: ModelCall = async (r) => {
      const out = await judgeCall(db, { userId, step: 'role.requirements', prompt: r.system, input: r.prompt, schema: ModelAnswerSchema, promptRef: r.promptRef, maxTokens: r.maxTokens }, deps.door)
      if (out.ok) {
        prov = out.prov
        return JSON.stringify(out.json)
      }
      if (out.limit === 'bad_answer') return null
      stop = out.limit
      return MODEL_LIMIT
    }
    req = await completeRequirements(base, { title: job.title, description, descriptionMd: job.description_md }, call, now)
    if (stop) return { req: base, stop }
    const p = prov as Prov | null
    if (p && req.items) {
      // The items the model added carry the declared step, the model and the time, not only the reader's step name.
      req = { ...req, items: req.items.map((i) => (i.origin === 'model' && i.prov.step === 'read-job-requirements' ? { ...i, prov: { step: p.step, model: p.model, at: p.at } } : i)) }
    }
  }
  if (req !== base || !current) {
    // Changing the record clears what was concluded from it, for everyone who holds the role (the reset trigger).
    await db.from('jobs').update({ requirements: req, requirements_extracted_at: now().toISOString() }).eq('id', job.id)
  }
  return { req, stop: null }
}

async function loadResume(db: AdminClient, userId: string): Promise<{ text: string; version: number; id: string | null } | null> {
  const base = await getBaseResume(db, userId)
  if (base?.content?.trim()) return { text: base.content, version: base.version, id: base.id }
  const { data } = await db.from('profiles').select('resume_text').eq('id', userId).maybeSingle()
  const text = (data as { resume_text?: string | null } | null)?.resume_text?.trim()
  return text ? { text, version: 0, id: null } : null
}

const sourceOf = (version: number) => (version > 0 ? `resume v${version}` : 'resume')

function readingsOf(p: Prepared, checks: readonly RequirementCheck[], source: string): Reading[] {
  const aligned = checks.length === p.scored.length
  return [
    ...p.scored.map(({ item }, i): Reading => {
      const c = aligned ? checks[i] : null
      return { id: item.id, text: item.text, kind: item.kind, status: c?.status ?? 'unclear', line: c?.evidence?.line ?? null, quote: c?.evidence?.quote ?? null, source }
    }),
    ...p.confirm.map((item): Reading => ({ id: item.id, text: item.text, kind: item.kind, status: 'unclear', line: null, quote: null, source, confirm: true })),
  ]
}

async function write(db: AdminClient, userId: string, jobId: string, row: { band: Chance; readings: Reading[]; prov: Record<string, unknown>; detail: Record<string, unknown> }, at: Date): Promise<void> {
  const iso = at.toISOString()
  const { error } = await db
    .from('person_roles')
    .update({ band: row.band, readings: row.readings, prov: row.prov, judged_at: iso, chance: row.band, chance_detail: row.detail, assessed_at: iso })
    .eq('user_id', userId)
    .eq('job_id', jobId)
  if (error) throw new Error('could not store a judgement')
}

/**
 * Judges the person's own roles among `jobIds`, three to a model call. A role the person does not hold is ignored. Stops at the
 * first limit the door answers and leaves the rest waiting. Never throws on a model failure.
 */
export async function judgeRoles(db: AdminClient, userId: string, jobIds: readonly string[], deps: JudgeDeps = {}): Promise<JudgeOutcome> {
  const now = deps.now ?? (() => new Date())
  const judged: string[] = []
  const resume = await loadResume(db, userId)
  if (!resume) return { judged, stopped: 'no_resume' }
  const source = sourceOf(resume.version)
  const resumeEvidence: Evidence[] = resume.id ? [{ table: 'resume_documents', id: resume.id }] : []

  const { data, error } = await ownedJobsQuery(db, userId, 'id, title, description, description_md, location, salary_range, requirements, viewer_company_name').in('id', [...jobIds])
  if (error) throw new Error('could not read roles')
  const byId = new Map(((data as unknown as JobRow[] | null) ?? []).map((j) => [j.id, j]))

  // 1. Requirements. A thin posting is finished here; the rest wait for the evidence step.
  const ready: { job: JobRow; prepared: Prepared }[] = []
  for (const id of jobIds) {
    const job = byId.get(id)
    if (!job) continue
    const { req, stop } = await requirementsOf(db, userId, job, deps)
    if (stop) return { judged, stopped: stop }
    const prepared = prepare(req)
    if (prepared.scored.length < MIN_REQUIREMENTS) {
      const detail = { checks: [], gaps: [], confirm: prepared.confirm.map((c) => c.text), note: NO_REQUIREMENTS_LINE }
      await write(db, userId, id, { band: 'cannot_assess', readings: readingsOf(prepared, [], source), prov: { rule: 'no_requirements', reason: TOO_FEW, at: now().toISOString() }, detail }, now())
      judged.push(id)
    } else ready.push({ job, prepared })
  }

  // 2. Evidence, three roles to a call, through the free door.
  for (const group of chunks(ready, ROLES_PER_CALL)) {
    let prov: Prov | null = null
    const runner: LlmRunner = async (opts) => {
      const out = await judgeCall(db, { userId, step: 'role.evidence', prompt: opts.system ?? '', input: opts.prompt ?? '', schema: ChecksAnswer, promptRef: opts.promptRef, maxTokens: opts.maxTokens }, deps.door)
      if (!out.ok) throw out.limit === 'bad_answer' ? new Error('bad_answer') : new ChanceStop(out.limit)
      prov = out.prov
      return { content: JSON.stringify(out.json), tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: out.prov.model }
    }
    let results: Map<string, ChanceResult>
    try {
      results = await assessChances(
        runner,
        resume.text,
        group.map(({ job, prepared }) => ({
          role: { id: job.id, title: job.title, company: job.viewer_company_name ?? '', location: job.location, description: job.description },
          outcome: { kind: 'ok' as const, requirements: prepared.scored.map((s) => s.requirement) },
        }))
      )
    } catch (error) {
      if (error instanceof ChanceStop) return { judged, stopped: error.limit as Stopped }
      throw error
    }
    for (const { job, prepared } of group) {
      const result = results.get(job.id)!
      const p = prov as Prov | null
      const provRow = p
        ? { ...p, evidence: [{ table: 'jobs', id: job.id }, ...resumeEvidence], at: now().toISOString() }
        : { rule: 'check_failed', at: now().toISOString() }
      const detail = { checks: result.checks, gaps: result.gaps, confirm: prepared.confirm.map((c) => c.text), note: result.note }
      await write(db, userId, job.id, { band: result.chance, readings: readingsOf(prepared, result.checks, source), prov: provRow, detail }, now())
      judged.push(job.id)
    }
  }
  return { judged, stopped: null }
}

export const judgeRole = (db: AdminClient, userId: string, jobId: string, deps?: JudgeDeps) => judgeRoles(db, userId, [jobId], deps)

/**
 * The person's waiting roles, newest kept first, roles at employers they follow before the rest. A role waits when it has no
 * judgement yet, a changed posting cleared it, or a changed resume marked it (the database triggers clear judged_at).
 * ponytail: looks at the newest 300 waiting roles and takes "followed" to mean the person has a company row for the employer.
 */
export async function nextWaiting(db: AdminClient, userId: string, limit: number): Promise<string[]> {
  const { data } = await db.from('person_roles').select('job_id, visible_since').eq('user_id', userId).is('judged_at', null).is('hidden_reason', null).order('visible_since', { ascending: false }).limit(WAITING_WINDOW)
  const ids = ((data as { job_id: string }[] | null) ?? []).map((r) => r.job_id)
  if (ids.length === 0) return []
  const followed = new Set<string>()
  for (const part of chunks(ids, 100)) {
    const { data: rows } = await ownedJobsQuery(db, userId, 'id, viewer_company_id').in('id', part)
    for (const r of (rows as unknown as { id: string; viewer_company_id: string | null }[] | null) ?? []) if (r.viewer_company_id) followed.add(r.id)
  }
  return [...ids.filter((id) => followed.has(id)), ...ids.filter((id) => !followed.has(id))].slice(0, limit)
}

export interface JudgeStatus {
  judgedToday: number
  waiting: number
  /** The line for the roles page, or null when nothing waits. */
  line: string | null
}

export const dayLine = (judgedToday: number, waiting: number) => `Cello judged ${judgedToday} of your ${judgedToday + waiting} new roles today. The rest continue tomorrow.`
export const checkingLine = (waiting: number) => `${waiting} more are being checked. Until then they are listed by title and date.`

/** What the roles page says about the judging: how many were judged today, how many wait, and why. Reads only. */
export async function judgeStatus(db: AdminClient, userId: string, deps: JudgeDeps = {}): Promise<JudgeStatus> {
  const door = deps.door ?? realDoor
  const now = deps.now ?? (() => new Date())
  const day = now().toISOString().slice(0, 10)
  const head = { count: 'exact' as const, head: true }
  const [today, waitingRows, budget] = await Promise.all([
    db.from('person_roles').select('job_id', head).eq('user_id', userId).is('hidden_reason', null).gte('judged_at', `${day}T00:00:00.000Z`),
    db.from('person_roles').select('job_id', head).eq('user_id', userId).is('hidden_reason', null).is('judged_at', null),
    db.from('judge_budget').select('calls, by_user').eq('day', day).maybeSingle(),
  ])
  const judgedToday = today.count ?? 0
  const waiting = waitingRows.count ?? 0
  if (waiting === 0) return { judgedToday, waiting, line: null }
  // The free allowance is only what limits a person without a key of their own.
  const own = await door.loadKeys(db, userId).then((k) => Boolean(k.openrouter), () => false)
  const { cap, share } = await shareFor(db, userId, door)
  const row = budget.data as { calls: number; by_user: Record<string, number> } | null
  const spent = !own && row !== null && (row.calls >= cap || (row.by_user?.[userId] ?? 0) >= share)
  return { judgedToday, waiting, line: spent ? dayLine(judgedToday, waiting) : checkingLine(waiting) }
}
