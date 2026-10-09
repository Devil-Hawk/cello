// The steps that take an application from Preparing to Ready, each a small piece of code that either
// carries on or says why the application waits (and on whom). Only `tailor` calls a model (the Writer).
//
//   check_open   the posting is still open
//   dedupe       nothing sent already, no live twin
//   read_form    a Greenhouse form's questions, matched to saved answers; one open row per question
//   resume       the document that goes with it
//   tailor       the Writer's tailored version of it, which waits for the person's approval
//
// No preparation for interviews: Cello does not do that.

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectApplyTarget } from '@/lib/ats-apply/detect'
import { assertAllowedHost, fetchJson } from '@/lib/ats'
import { resolveFieldValues, type FormField } from '@/lib/answers'
import type { NeedsReason } from '@/lib/pipeline/types'
import { createHash } from 'node:crypto'
import { getLatestVersion } from '@/lib/resume/store'
import { currentResume } from './documents'

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
  /** Writes the tailored resume for this role (the Writer). Null when it could not. Tests pass their own. */
  tailorResume?: (app: StepApp) => Promise<{ artifact_id: string; version: number } | null>
}

export type StepOutcome =
  | { kind: 'continue'; line: string; payload?: Record<string, unknown> }
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

/** The questions of a Greenhouse `?questions=true` payload as form fields: one per question, its options kept. */
export function readGreenhouseFields(payload: unknown): FormField[] {
  const qs = ((payload as { questions?: GhQuestion[] } | null)?.questions ?? []).filter((q) => q && typeof q.label === 'string')
  const out: FormField[] = []
  for (const q of qs) {
    const f = q.fields?.[0]
    if (!f?.name) continue
    const options = (f.values ?? []).map((v) => String(v.label ?? '')).filter(Boolean)
    const type = f.type ?? 'input_text'
    if (type === 'input_file') continue // the documents are not questions
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
    if (job.closed_at || job.still_open === false) return { kind: 'close', closedReason: 'posting_closed', line: 'The posting is closed.' }
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
    try {
      const host = target.host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io'
      fields = readGreenhouseFields(await fetchForm(`https://${host}/v1/boards/${target.slug}/jobs/${target.jobId}?questions=true`))
    } catch {
      return { kind: 'continue', line: 'Cello could not read this form ahead of time. It will read it when you open it.' }
    }
    await admin.from('applications').update({ form_fields: fields }).eq('id', app.id).eq('user_id', app.user_id)
    const { open } = await resolveFieldValues(admin, app.user_id, fields, { companyId: job.company_id, companyName: job.companyName, applicationId: app.id })
    if (open.length > 0) {
      return { kind: 'wait', reason: 'answer', detail: { answer_ids: [...new Set(open.map((o) => o.answerId))], questions: open.map((o) => o.question).slice(0, 10) }, line: `${open.length} ${open.length === 1 ? 'question needs' : 'questions need'} your answer.` }
    }
    return { kind: 'continue', line: `Read ${fields.length} questions; every required one has an answer.` }
  },
}

export const resume: Step = {
  id: 'resume',
  doing: 'Using your base resume',
  async run({ admin, app }) {
    const doc = await currentResume(admin, app.user_id)
    if (!doc) return { kind: 'wait', reason: 'approve_resume', detail: { cause: 'no_resume' }, line: 'Add your resume first.' }
    return { kind: 'continue', line: 'Using your base resume.', payload: { resume_document_id: doc.id } }
  },
}

/** The Writer, on the person's keys, for this role. */
async function writeTailored(admin: SupabaseClient, app: StepApp): Promise<{ artifact_id: string; version: number } | null> {
  const { loadApiKeys } = await import('@/lib/harness/keys')
  const { runWriter } = await import('@/lib/workflows/writer')
  const { newDeadline } = await import('@/lib/agents/context')
  const apiKeys = await loadApiKeys(admin as never, app.user_id)
  const out = await runWriter(
    { ctx: { admin: admin as never, userId: app.user_id, userEmail: '', apiKeys, isDemo: apiKeys.isDemo !== false, threadId: '', conversationId: null, autonomy: 'ask', traceId: '', deadlineAt: newDeadline() } },
    { type: 'resume', job_id: app.job_id }
  )
  if (out.status === 'failed' || !out.artifact_id) console.warn('advance: the Writer could not tailor the resume:', out.error, out.fix)
  return out.artifact_id && out.version && out.status !== 'failed' ? { artifact_id: out.artifact_id, version: out.version } : null
}

export const tailor: Step = {
  id: 'tailor',
  doing: 'Tailoring your resume',
  async run({ admin, app, tailorResume }) {
    // The version for this role: written once, then only read. The person approves exactly this text.
    let doc = await getLatestVersion(admin, app.user_id, app.job_id)
    if (!doc) {
      const made = await (tailorResume ?? ((a) => writeTailored(admin, a)))(app).catch(() => null)
      if (!made) return { kind: 'continue', line: 'Cello could not tailor your resume, so your base resume goes with it.' }
      doc = await getLatestVersion(admin, app.user_id, app.job_id)
      if (!doc) return { kind: 'continue', line: 'Cello could not tailor your resume, so your base resume goes with it.' }
    }
    const hash = createHash('sha256').update(doc.content).digest('hex').slice(0, 32)
    const { data } = await admin.from('pipeline_events').select('id').eq('application_id', app.id).eq('user_id', app.user_id).eq('kind', 'approval.decided').contains('payload', { hash }).limit(1)
    const detail = { artifact_id: doc.artifact_id, version: doc.version, hash }
    if (data && data.length > 0) return { kind: 'continue', line: `You approved version ${doc.version} of the tailored resume.`, payload: detail }
    return { kind: 'wait', reason: 'approve_resume', detail, line: `Needs you: approve version ${doc.version} of the tailored resume.` }
  },
}

/** Preparing to Ready, in this order. */
export const STEPS: readonly Step[] = [checkOpen, dedupe, readForm, resume, tailor]
