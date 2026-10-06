// What the extension is given for one application: the values for the fields its form asks, where each
// came from, the questions left for the person, the fields it must leave blank, and the account-portal
// sentence. Values only for the fields asked; a secret, a password or a sensitive answer is never part of
// it (the resolver never produces one).

import type { SupabaseClient } from '@supabase/supabase-js'
import { classify, resolveFieldValues, type FormField, type Resolved } from '@/lib/answers'
import { currentResume } from '@/lib/advance/documents.stub'
import { eligibility, type EligibleField } from './eligibility'
import { portalOf } from './portals'

export interface FillApp {
  id: string
  user_id: string
  state: string | null
  posting_url_hash: string | null
  auto_attempted_at: string | null
  lease_holder: string | null
  last_event_at: string | null
  form_fields: FormField[] | null
  job_id: string
  jobs: { url: string; title: string; company_id: string; companies: { name: string } | null } | null
}

const COLUMNS = 'id, user_id, state, posting_url_hash, auto_attempted_at, lease_holder, last_event_at, form_fields, job_id, jobs(url, title, company_id, companies(name))'

export async function loadFillApp(admin: SupabaseClient, userId: string, applicationId: string): Promise<FillApp | null> {
  const { data } = await admin.from('applications').select(COLUMNS).eq('id', applicationId).eq('user_id', userId).maybeSingle()
  const a = data as unknown as FillApp | null
  return a && a.jobs ? a : null
}

export interface FillSession {
  applicationId: string
  company: string
  title: string
  values: Record<string, { value: unknown; via: Resolved['via']; usedQuestion?: string }>
  open: { fieldId: string; question: string }[]
  never: string[]
  portal: string | null
  files: { kind: 'resume'; name: string; id: string }[]
  /** Why Send for me may not send this one (null when it may). Informational: the claim checks again. */
  autoReason: string | null
}

/** Clean what the extension may fill: never a field of another kind than the form lists. */
export function cleanFields(raw: unknown): FormField[] | null {
  if (!Array.isArray(raw) || raw.length > 200) return null
  const out: FormField[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') return null
    const o = f as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id || o.id.length > 200 || typeof o.label !== 'string' || !o.label || o.label.length > 500) return null
    out.push({
      id: o.id,
      label: o.label,
      required: o.required === true,
      kind: typeof o.kind === 'string' ? (o.kind as FormField['kind']) : undefined,
      options: Array.isArray(o.options) ? (o.options as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 100) : undefined,
    })
  }
  return out
}

export async function buildSession(admin: SupabaseClient, app: FillApp, fields: readonly FormField[]): Promise<FillSession> {
  const job = app.jobs!
  const company = job.companies?.name ?? 'the company'
  const r = await resolveFieldValues(admin, app.user_id, fields, { companyId: job.company_id, companyName: job.companies?.name ?? null, applicationId: app.id })
  const eligible: EligibleField[] = fields.map((f) => {
    const a = classify(f, job.companies?.name ?? null)
    return { label: f.label, category: a.category, kind: a.kind, required: f.required === true, options: a.options, resolved: r.values[f.id] }
  })
  const doc = await currentResume(admin, app.user_id)
  return {
    applicationId: app.id,
    company,
    title: job.title,
    values: Object.fromEntries(Object.entries(r.values).map(([id, v]) => [id, { value: v.value, via: v.via, usedQuestion: v.usedQuestion }])),
    open: r.open.map((o) => ({ fieldId: o.fieldId, question: o.question })),
    never: r.never,
    portal: portalOf(job.url)?.sentence ?? null,
    files: doc ? [{ kind: 'resume', name: doc.name, id: doc.id }] : [],
    autoReason: eligibility({ company, url: job.url, fields: eligible }),
  }
}
