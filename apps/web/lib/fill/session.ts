// What the extension is given for one application: the values for the fields its form asks, where each
// came from, the questions left for the person, the fields it must leave blank, and the account-portal
// sentence. Values only for the fields asked; a secret, a password or a sensitive answer is never part of
// it (the resolver never produces one).

import type { SupabaseClient } from '@supabase/supabase-js'
import { classify, resolveFieldValues, type FormField, type Resolved } from '@/lib/answers'
import { currentResume } from '@/lib/advance/documents'
import { eligibility, type EligibleField } from './eligibility'
import { portalOf } from './portals'
import type { ServerField } from './wire'
import { postingUrlHash } from '@/lib/pipeline/posting'

export interface FillApp {
  id: string
  user_id: string
  state: string | null
  posting_url_hash: string | null
  auto_attempted_at: string | null
  lease_holder: string | null
  lease_until: string | null
  needs_reason: string | null
  last_event_at: string | null
  form_fields: FormField[] | null
  job_id: string
  jobs: { url: string; title: string; company_id: string; companies: { name: string } | null } | null
}

const COLUMNS = 'id, user_id, state, posting_url_hash, auto_attempted_at, lease_holder, lease_until, needs_reason, last_event_at, form_fields, job_id, jobs(url, title, company_id, companies(name))'

export async function loadFillApp(admin: SupabaseClient, userId: string, applicationId: string): Promise<FillApp | null> {
  const { data } = await admin.from('applications').select(COLUMNS).eq('id', applicationId).eq('user_id', userId).maybeSingle()
  const a = data as unknown as FillApp | null
  return a && a.jobs ? a : null
}

/** The application a page is the form of: the ones the person may fill, matched by the posting's address. */
export async function findFillAppByUrl(admin: SupabaseClient, userId: string, url: string): Promise<FillApp | null> {
  const hash = postingUrlHash(url)
  if (!hash) return null
  const { data } = await admin.from('applications').select(COLUMNS).eq('user_id', userId).eq('posting_url_hash', hash).in('state', ['ready', 'applying', 'needs_you']).order('last_event_at', { ascending: false }).limit(1).maybeSingle()
  const a = data as unknown as FillApp | null
  return a && a.jobs ? a : null
}

export interface FillSession {
  applicationId: string
  company: string
  title: string
  values: Record<string, { value: unknown; via: Resolved['via']; origin: Resolved['origin']; usedQuestion?: string }>
  open: { fieldId: string; question: string }[]
  never: string[]
  portal: string | null
  files: { kind: 'resume'; name: string; id: string }[]
  /** Why Send for me may not send this one (null when it may). Informational: the claim checks again. */
  autoReason: string | null
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
    values: Object.fromEntries(Object.entries(r.values).map(([id, v]) => [id, { value: v.value, via: v.via, origin: v.origin, usedQuestion: v.usedQuestion }])),
    open: r.open.map((o) => ({ fieldId: o.fieldId, question: o.question })),
    never: r.never,
    portal: portalOf(job.url)?.sentence ?? null,
    files: doc ? [{ kind: 'resume', name: doc.name, id: doc.id }] : [],
    autoReason: eligibility({ company, url: job.url, fields: eligible }),
  }
}

type Source = 'profile' | 'person' | 'resume' | 'draft'

/** The session as the extension reads it: a value and its source per field key, the category of every field, nothing else. */
export function toWire(session: FillSession, fields: readonly ServerField[]) {
  const source = (v: FillSession['values'][string], origin: string): Source => (v.via === 'profile' || v.via === 'fact' ? 'profile' : origin === 'code' ? 'resume' : origin === 'model' ? 'draft' : 'person')
  const values: Record<string, { value: string | boolean; source: Source }> = {}
  for (const [key, v] of Object.entries(session.values)) {
    const value = typeof v.value === 'boolean' ? v.value : typeof v.value === 'string' || typeof v.value === 'number' ? String(v.value) : null
    if (value !== null) values[key] = { value, source: source(v, v.origin) }
  }
  const categories: Record<string, string> = {}
  for (const f of fields) categories[f.key] = f.category === 'eeo' || f.category === 'consent' || f.category === 'motivation' ? f.category : ['work_auth', 'sponsorship', 'salary'].includes(f.category) ? 'sensitive' : 'standard'
  return { values, categories }
}
