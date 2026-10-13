// The steps that take an application from Preparing to Ready, each a small piece of code that either
// carries on or says why the application waits (and on whom). Only `tailor` calls a model (the Writer).
//
//   check_open   the posting is still open
//   dedupe       nothing sent already, no live twin
//   read_form    a Greenhouse form's questions, matched to saved answers; one open row per question
//   resume       the base resume it starts from
//   tailor       the Writer's tailored version of it, which waits for the person's approval (or goes without one
//                under Hands-off) and is then attached to the application: applications.resume_artifact_id, the
//                document the extension is handed (lib/fill/session.ts) and the one the send check reads
//
// Two steps are added only when a form asks for them, by the step that learns it (read_form), and the thread says
// what changed and why (acceptance P3):
//   draft_answers  Cello's drafts of the open long questions, for the person to check (the `answers.draft` step)
//   cover_letter   the Writer's letter, which waits for approval exactly as the tailored resume does
//
// No preparation for interviews: Cello does not do that.

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectApplyTarget } from '@/lib/ats-apply/detect'
import { assertAllowedHost, fetchJson } from '@/lib/ats'
import { resolveFieldValues, type FormField } from '@/lib/answers'
import type { NeedsReason } from '@/lib/pipeline/types'
import { createHash } from 'node:crypto'
import { reasonOf } from '@/lib/models/caps'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { getBaseResume, getLatestVersion } from '@/lib/resume/store'
import { listArtifacts, getArtifact } from '@/lib/agents/artifacts'
import { currentResume } from './documents'

/** The steps a step may add, and why, in the words the thread shows. */
export type AddedStep = { step: 'draft_answers' | 'cover_letter'; why: string }

export interface StepApp {
  id: string
  user_id: string
  job_id: string
  posting_url_hash: string | null
}

export interface StepJob {
  url: string
  title: string
  company_id: string
  closed_at: string | null
  still_open: boolean | null
  companyName: string | null
}

export interface StepCtx {
  admin: SupabaseClient
  app: StepApp
  job: StepJob
  fetchForm: (url: string) => Promise<unknown>
  /** Writes the tailored resume for this role (the Writer), or says why it could not. Tests pass their own. */
  tailorResume?: (app: StepApp) => Promise<{ artifact_id: string; version: number } | { error: string } | null>
  /** Writes the cover letter for this role (the Writer), or says why it could not. Tests pass their own. */
  writeCoverLetter?: (app: StepApp) => Promise<{ artifact_id: string; version: number } | { error: string } | null>
  /** Drafts one open answer (lib/answers/draft.ts). Tests pass their own. */
  draftAnswer?: (app: StepApp, q: { answerId: string; question: string }) => Promise<{ ok: boolean; reason?: string }>
}

export type StepOutcome =
  | { kind: 'continue'; line: string; payload?: Record<string, unknown>; add?: AddedStep[] }
  | { kind: 'wait'; reason: NeedsReason; detail?: Record<string, unknown>; line: string }
  | { kind: 'close'; closedReason: 'posting_closed'; line: string }

export interface Step {
  id: string
  /** The line shown while it runs. */
  doing: string
  run: (c: StepCtx) => Promise<StepOutcome>
}

const GH_API = new Set(['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'])

export const defaultFetchForm = async (url: string): Promise<unknown> => {
  assertAllowedHost(url, GH_API)
  return fetchJson<unknown>(url)
}

interface GhQuestion {
  label?: string | null
  required?: boolean | null
  fields?: { name?: string | null; type?: string | null; values?: { label?: string | null; value?: string | number | null }[] | null }[] | null
}

/** The documents a Greenhouse form asks for as files: a required cover letter adds the step that writes one. */
export function readGreenhouseFiles(payload: unknown): { label: string; required: boolean }[] {
  const qs = ((payload as { questions?: GhQuestion[] } | null)?.questions ?? []).filter((q) => q && typeof q.label === 'string')
  return qs.filter((q) => q.fields?.[0]?.type === 'input_file').map((q) => ({ label: q.label as string, required: q.required === true }))
}

/** The questions of a Greenhouse `?questions=true` payload as form fields: one per question, its options kept. */
export function readGreenhouseFields(payload: unknown): FormField[] {
  const qs = ((payload as { questions?: GhQuestion[] } | null)?.questions ?? []).filter((q) => q && typeof q.label === 'string')
  const out: FormField[] = []
  for (const q of qs) {
    const f = q.fields?.[0]
    if (!f?.name) continue
    const options = (f.values ?? []).map((v) => String(v.label ?? '')).filter(Boolean)
    const type = f.type ?? 'input_text'
    if (type === 'input_file') continue // the documents are not questions (readGreenhouseFiles lists them)
    out.push({
      id: f.name,
      label: q.label as string,
      required: q.required === true,
      kind: type === 'textarea' ? 'long_text' : type === 'multi_value_multi_select' ? 'multi_select' : options.length ? 'select' : 'text',
      options: options.length ? options : undefined,
    })
  }
  return out
}

export const checkOpen: Step = {
  id: 'check_open',
  doing: 'Checking the posting is still open',
  async run({ job }) {
    if (job.closed_at || job.still_open === false) return { kind: 'close', closedReason: 'posting_closed', line: 'The posting is closed. Dropped the remaining steps.' }
    return { kind: 'continue', line: 'The posting is open.' }
  },
}

export const dedupe: Step = {
  id: 'dedupe',
  doing: 'Checking you have not applied already',
  async run({ admin, app }) {
    if (!app.posting_url_hash) return { kind: 'continue', line: 'No earlier application found.' }
    const { data, error } = await admin.rpc('pipeline_send_blocked', { p_user: app.user_id, p_hash: app.posting_url_hash })
    if (error) throw new Error(`pipeline_send_blocked failed: ${error.message}`)
    if (data === true) return { kind: 'wait', reason: 'duplicate', line: 'You may have applied to this already.' }
    // a live twin (the same posting in another application) shares the dedupe key and is refused by the index
    const { error: key } = await admin.from('applications').update({ dedupe_key: app.posting_url_hash }).eq('id', app.id).eq('user_id', app.user_id)
    if (key?.code === '23505') return { kind: 'wait', reason: 'duplicate', line: 'You may have applied to this already.' }
    return { kind: 'continue', line: 'No earlier application found.' }
  },
}

export const readForm: Step = {
  id: 'read_form',
  doing: 'Reading the application form',
  async run({ admin, app, job, fetchForm }) {
    const target = detectApplyTarget(job.url)
    if (!target || target.provider !== 'greenhouse' || !target.jobId) return { kind: 'continue', line: 'Cello will read this form when you open it.' }
    let fields: FormField[]
    let files: { label: string; required: boolean }[]
    try {
      const host = target.host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io'
      const payload = await fetchForm(`https://${host}/v1/boards/${target.slug}/jobs/${target.jobId}?questions=true`)
      fields = readGreenhouseFields(payload)
      files = readGreenhouseFiles(payload)
    } catch {
      return { kind: 'continue', line: 'Cello could not read this form ahead of time. It will read it when you open it.' }
    }
    await admin.from('applications').update({ form_fields: fields }).eq('id', app.id).eq('user_id', app.user_id)
    const { open } = await resolveFieldValues(admin, app.user_id, fields, { companyId: job.company_id, companyName: job.companyName, applicationId: app.id })
    // What the form asks for that the plan did not have: the steps are added here, and the thread says why.
    const add: AddedStep[] = []
    const long = open.filter((o) => fields.find((f) => f.id === o.fieldId)?.kind === 'long_text')
    if (long.length > 0) add.push({ step: 'draft_answers', why: `The form asks ${long.length} ${long.length === 1 ? 'question' : 'questions'} you have not answered.` })
    if (files.some((f) => f.required && /cover letter/i.test(f.label))) add.push({ step: 'cover_letter', why: 'The form asks for a cover letter.' })
    if (open.length > 0 && long.length === 0) {
      return { kind: 'wait', reason: 'answer', detail: { answer_ids: [...new Set(open.map((o) => o.answerId))], questions: open.map((o) => o.question).slice(0, 10) }, line: `${open.length} ${open.length === 1 ? 'question needs' : 'questions need'} your answer.` }
    }
    const line = open.length > 0 ? `Read ${fields.length} questions; ${open.length} ${open.length === 1 ? 'needs' : 'need'} your answer.` : `Read ${fields.length} questions; every required one has an answer.`
    return { kind: 'continue', line, ...(add.length ? { add } : {}) }
  },
}

/** Cello's draft of each open long question, then the stop for the person: every open row, drafted or not. */
async function draftOpenAnswer(admin: SupabaseClient, app: StepApp, q: { answerId: string; question: string }): Promise<{ ok: boolean; reason?: string }> {
  const { draftAnswer } = await import('@/lib/answers/draft')
  const { gatherApplyContext } = await import('@/lib/workflows/gather/apply')
  const context = await gatherApplyContext(admin as never, app.user_id, app.job_id)
  const base = await getBaseResume(admin, app.user_id).catch(() => null)
  const out = await draftAnswer(admin, app.user_id, { question: q.question, answerId: q.answerId, context, resume: base ? { id: base.id, text: base.content } : null, applicationId: app.id })
  return out.ok ? { ok: true } : { ok: false, reason: out.reason }
}

export const draftAnswers: Step = {
  id: 'draft_answers',
  doing: 'Drafting answers for you to check',
  async run({ admin, app, job, draftAnswer }) {
    const { data } = await admin.from('applications').select('form_fields').eq('id', app.id).eq('user_id', app.user_id).maybeSingle()
    const fields = ((data as { form_fields: FormField[] | null } | null)?.form_fields ?? []) as FormField[]
    const { open } = await resolveFieldValues(admin, app.user_id, fields, { companyId: job.company_id, companyName: job.companyName, applicationId: app.id })
    if (open.length === 0) return { kind: 'continue', line: 'Every question has an answer.' }
    const long = open.filter((o) => fields.find((f) => f.id === o.fieldId)?.kind === 'long_text')
    let drafted = 0
    let reason: string | null = null
    for (const q of long) {
      const r = await (draftAnswer ?? ((a, qq) => draftOpenAnswer(admin, a, qq)))(app, q).catch((e: unknown) => ({ ok: false, reason: reasonOf(e) ?? undefined }))
      if (r.ok) drafted++
      else reason ??= r.reason ?? null
    }
    const detail = { answer_ids: [...new Set(open.map((o) => o.answerId))], questions: open.map((o) => o.question).slice(0, 10), drafted }
    if (drafted > 0) return { kind: 'wait', reason: 'answer', detail, line: `Drafted ${drafted} ${drafted === 1 ? 'answer' : 'answers'} for you to check. Cello never sends an answer you did not give.` }
    const why = reason ? ` Cello could not draft them (${reason.replace(/\.$/, '')}).` : ''
    return { kind: 'wait', reason: 'answer', detail, line: `${open.length} ${open.length === 1 ? 'question needs' : 'questions need'} your answer.${why}` }
  },
}

export const resume: Step = {
  id: 'resume',
  doing: 'Starting from your base resume',
  async run({ admin, app }) {
    const doc = await currentResume(admin, app.user_id)
    if (!doc) return { kind: 'wait', reason: 'approve_resume', detail: { cause: 'no_resume' }, line: 'Add your resume first.' }
    return { kind: 'continue', line: 'Starting from your base resume.', payload: { resume_document_id: doc.id } }
  },
}

/** The Writer, on the person's keys, for this role; its own reason when it could not write. */
async function writeTailored(admin: SupabaseClient, app: StepApp): Promise<{ artifact_id: string; version: number } | { error: string }> {
  const { loadApiKeys } = await import('@/lib/harness/keys')
  const { runWriter } = await import('@/lib/workflows/writer')
  const { newDeadline } = await import('@/lib/agents/context')
  const { roleKeys } = await import('@/lib/models/choice')
  // Nobody is watching: the person's model for background work, which follows Chat when they never chose one.
  const apiKeys = await roleKeys(admin as never, app.user_id, await loadApiKeys(admin as never, app.user_id), 'worker')
  const out = await runWriter(
    { ctx: { admin: admin as never, userId: app.user_id, userEmail: '', apiKeys, isDemo: apiKeys.isDemo !== false, threadId: '', conversationId: null, autonomy: 'ask', traceId: '', deadlineAt: newDeadline() } },
    { type: 'resume', job_id: app.job_id }
  )
  if (out.artifact_id && out.version && out.status !== 'failed') return { artifact_id: out.artifact_id, version: out.version }
  console.warn('advance: the Writer could not tailor the resume:', out.error, out.fix)
  return { error: out.error ?? 'no reason was given' }
}

/** The Writer's cover letter for this role, on the person's keys, with the whole context; its own reason when it could not write. */
async function writeLetter(admin: SupabaseClient, app: StepApp): Promise<{ artifact_id: string; version: number } | { error: string }> {
  const { loadApiKeys } = await import('@/lib/harness/keys')
  const { runWriter } = await import('@/lib/workflows/writer')
  const { newDeadline } = await import('@/lib/agents/context')
  const { roleKeys } = await import('@/lib/models/choice')
  const apiKeys = await roleKeys(admin as never, app.user_id, await loadApiKeys(admin as never, app.user_id), 'worker')
  const out = await runWriter(
    { ctx: { admin: admin as never, userId: app.user_id, userEmail: '', apiKeys, isDemo: apiKeys.isDemo !== false, threadId: '', conversationId: null, autonomy: 'ask', traceId: '', deadlineAt: newDeadline() } },
    { type: 'cover_letter', job_id: app.job_id, idempotency_key: `cover_letter:${app.id}` }
  )
  if (out.artifact_id && out.version && out.status !== 'failed') return { artifact_id: out.artifact_id, version: out.version }
  console.warn('advance: the Writer could not write the cover letter:', out.error, out.fix)
  return { error: out.error ?? 'no reason was given' }
}

/** True when Chat started this application under Hands-off: the newest created event (a start again writes another) carries the mode code chose (lib/chat/mode.ts). */
export async function startedHandsOff(admin: SupabaseClient, app: Pick<StepApp, 'id' | 'user_id'>): Promise<boolean> {
  const { data } = await admin.from('pipeline_events').select('payload').eq('application_id', app.id).eq('user_id', app.user_id).eq('kind', 'application.created').order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as { payload: { mode?: unknown } | null } | null)?.payload?.mode === 'hands_off'
}

/** Hands-off may skip the resume stop only while Send for me is on and the person does not ask to see each resume first. */
async function skipsResumeReview(admin: SupabaseClient, app: StepApp): Promise<boolean> {
  if (!(await startedHandsOff(admin, app))) return false
  const { data } = await admin.from('profiles').select('preferences').eq('id', app.user_id).maybeSingle()
  const s = readPipelineSettings((data as { preferences: unknown } | null)?.preferences)
  return s.send.mode === 'auto' && !s.resumeApproval
}

/** The step's line when the base resume goes instead, with the reason when one is known (a free cap reaches the person here). */
function notTailored(why: string | null): StepOutcome {
  const reason = why?.replace(/^The draft could not be written: /, '').replace(/\.$/, '')
  return { kind: 'continue', line: reason ? `Cello could not tailor your resume (${reason}), so your base resume goes with it.` : 'Cello could not tailor your resume, so your base resume goes with it.' }
}

export const tailor: Step = {
  id: 'tailor',
  doing: 'Tailoring your resume',
  async run({ admin, app, tailorResume }) {
    // The version for this role: written once, then only read. The person approves exactly this text.
    let doc = await getLatestVersion(admin, app.user_id, app.job_id)
    if (!doc) {
      const made = await (tailorResume ?? ((a) => writeTailored(admin, a)))(app).catch((e: unknown) => ({ error: reasonOf(e) ?? '' }))
      if (!made) return notTailored(null)
      if ('error' in made) return notTailored(made.error || null)
      doc = await getLatestVersion(admin, app.user_id, app.job_id)
      if (!doc) return notTailored(null)
    }
    const hash = createHash('sha256').update(doc.content).digest('hex').slice(0, 32)
    const { data } = await admin.from('pipeline_events').select('id').eq('application_id', app.id).eq('user_id', app.user_id).eq('kind', 'approval.decided').contains('payload', { hash }).limit(1)
    const detail = { artifact_id: doc.artifact_id, version: doc.version, hash }
    // The version that goes with it: the row the extension's session and the send check read.
    const artifactId = doc.artifact_id
    const attach = async () => {
      const { error } = await admin.from('applications').update({ resume_artifact_id: artifactId }).eq('id', app.id).eq('user_id', app.user_id)
      if (error) throw new Error(`attaching the tailored resume failed: ${error.message}`)
    }
    if (data && data.length > 0) {
      await attach()
      return { kind: 'continue', line: `You approved version ${doc.version} of the tailored resume.`, payload: detail }
    }
    if (await skipsResumeReview(admin, app)) {
      await attach()
      return { kind: 'continue', line: `Hands-off: version ${doc.version} of the tailored resume goes with it, without asking you.`, payload: detail }
    }
    // A tailoring that changed nothing is not called tailored: the person approves their own resume, as it is.
    const unchanged = Boolean(doc.title?.endsWith('(unchanged)'))
    return { kind: 'wait', reason: 'approve_resume', detail, line: unchanged ? `Needs you: approve version ${doc.version} of your resume. Nothing in it needed changing for this role.` : `Needs you: approve version ${doc.version} of the tailored resume.` }
  },
}

export const coverLetter: Step = {
  id: 'cover_letter',
  doing: 'Writing the cover letter',
  async run({ admin, app, writeCoverLetter }) {
    // Written once for this application, then only read: the person approves exactly this text.
    const current = async () => {
      const [a] = await listArtifacts(admin as never, app.user_id, { type: 'cover_letter', jobId: app.job_id, limit: 1 })
      const got = a ? await getArtifact(admin as never, app.user_id, a.id) : null
      return got ? { artifact_id: got.artifact.id, version: got.version.version, text: got.version.content_text } : null
    }
    let doc = await current()
    if (!doc) {
      const made = await (writeCoverLetter ?? ((a) => writeLetter(admin, a)))(app).catch((e: unknown) => ({ error: reasonOf(e) ?? '' }))
      const why = made && 'error' in made ? made.error.replace(/^The draft could not be written: /, '').replace(/\.$/, '') : null
      doc = made && !('error' in made) ? await current() : null
      if (!doc) return { kind: 'continue', line: why ? `Cello could not write the cover letter (${why}). Write one yourself if the form needs it.` : 'Cello could not write the cover letter. Write one yourself if the form needs it.' }
    }
    const hash = createHash('sha256').update(doc.text).digest('hex').slice(0, 32)
    const detail = { artifact_id: doc.artifact_id, version: doc.version, hash, what: 'cover_letter' }
    const { data } = await admin.from('pipeline_events').select('id').eq('application_id', app.id).eq('user_id', app.user_id).eq('kind', 'approval.decided').contains('payload', { hash }).limit(1)
    if (data && data.length > 0) return { kind: 'continue', line: `You approved version ${doc.version} of the cover letter.`, payload: detail }
    if (await skipsResumeReview(admin, app)) return { kind: 'continue', line: `Hands-off: version ${doc.version} of the cover letter goes with it, without asking you.`, payload: detail }
    return { kind: 'wait', reason: 'approve_resume', detail, line: 'Needs you: approve the cover letter.' }
  },
}

/** Preparing to Ready, in this order. A step a form asks for is inserted after the step that added it (lib/advance/index.ts). */
export const STEPS: readonly Step[] = [checkOpen, dedupe, readForm, resume, tailor]
export const ADDED_STEPS: Record<AddedStep['step'], Step> = { draft_answers: draftAnswers, cover_letter: coverLetter }
