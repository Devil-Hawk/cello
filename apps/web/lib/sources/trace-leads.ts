// Leads, traced or counted (part 6, "Leads").
//
// A feed's hit or a web search's hit is a lead, not a role. It becomes a role only when it is traced to the employer's
// own posting: its address is on the employer's own site or board, or the employer's board already lists that role.
// The employer behind it passes the same verifier as any other (companies.verify, source = lead) and joins the
// directory; a feed never creates an employer by itself. A lead that cannot be traced is a number, kept for the person
// as a count ("14 leads not traced to an employer's own posting"), never a row, never a company.
//
// Behind the instance flag directory_leads: until the directory has filled (migration 20261008060003, applied by the owner once T26 shows the fill far along) leads keep
// their old path, so nothing is lost while the seed is still being verified.

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectFromUrl } from '../ats/detect'
import { jobRow } from '../ats/index'
import type { AtsJob } from '../ats/types'
import { normalizeCompanyName } from '../entities/companies'
import { onOwnSite } from '../ingest/reader/legit'
import { classifyJob } from '../jobs/classify'
import { typeTitle } from '../jobs/role-types'
import { realDeps, verifyEmployer, type VerifyDeps } from '../companies/verify-directory'
import type { JobLead } from './types'

type Db = SupabaseClient<any, any, any>

/** Leads whose employer is looked up on the open web in one batch: the rest are counted. */
export const VERIFY_PER_BATCH = 5

interface Employer {
  id: string
  name: string
  domain: string | null
  careers_url: string | null
  ats_provider: string | null
  ats_token: string | null
}

const COLUMNS = 'id, name, domain, careers_url, ats_provider, ats_token'

export interface TraceResult {
  jobIds: string[]
  inserted: number
  /** Leads that could not be traced to an employer's own posting. */
  untraced: number
  errors: string[]
}

/** Is the directory ready to take leads? Any failure to read the flag is "no": the old path runs. */
export async function leadsAreTraced(db: Db): Promise<boolean> {
  try {
    const { data } = await db.from('instance_flags').select('on').eq('key', 'directory_leads').maybeSingle()
    return (data as { on?: boolean } | null)?.on === true
  } catch {
    return false
  }
}

const bareDomain = (d: string | null | undefined) => d?.toLowerCase().replace(/^www\./, '') || null

async function findEmployer(db: Db, lead: JobLead, board: { provider: string; token: string } | null): Promise<Employer | null> {
  const domain = bareDomain(lead.companyDomain)
  if (domain) {
    const { data } = await db.from('company_directory').select(COLUMNS).eq('domain', domain).not('verified_at', 'is', null).maybeSingle()
    if (data) return data as Employer
  }
  if (board) {
    const { data } = await db.from('company_directory').select(COLUMNS).eq('ats_provider', board.provider).eq('ats_token', board.token).not('verified_at', 'is', null).maybeSingle()
    if (data) return data as Employer
  }
  // By name only when the name is one verified employer's: a common word (Mercury, Ramp, Notion) names several.
  const norm = normalizeCompanyName(lead.company)
  if (!norm) return null
  const { data } = await db.from('company_directory').select(COLUMNS).eq('name_norm', norm).not('verified_at', 'is', null).limit(2)
  const rows = (data ?? []) as Employer[]
  return rows.length === 1 ? rows[0] : null
}

/** Lead addresses on the employer's own site or on its verified board. */
function onEmployer(lead: JobLead, employer: Employer, board: { provider: string; token: string } | null): boolean {
  if (board && employer.ats_provider === board.provider && employer.ats_token?.toLowerCase() === board.token.toLowerCase()) return true
  return onOwnSite(lead.url, { company: { name: employer.name, domain: employer.domain, careerUrl: employer.careers_url } })
}

const sameRole = (leadLocation: string | null, stored: string | null) =>
  !leadLocation || !stored || stored.toLowerCase().includes(leadLocation.toLowerCase()) || leadLocation.toLowerCase().includes(stored.toLowerCase())

export async function traceLeads(db: Db, userId: string, leads: JobLead[], deps: { verify: VerifyDeps } = { verify: realDeps }): Promise<TraceResult> {
  const out: TraceResult = { jobIds: [], inserted: 0, untraced: 0, errors: [] }
  const bySource: Record<string, number> = {}
  const employers = new Map<string, Employer | null>()
  let verifying = 0
  const now = new Date().toISOString()
  const toStore: { employer: Employer; lead: JobLead }[] = []
  const seen = new Set<string>()

  for (const lead of leads) {
    if (seen.has(lead.externalId)) continue
    seen.add(lead.externalId)
    const direct = detectFromUrl({ careerUrl: lead.url, domain: null })
    const key = `${bareDomain(lead.companyDomain) ?? ''}|${normalizeCompanyName(lead.company)}|${direct ? `${direct.provider}:${direct.token}` : ''}`
    let employer = employers.get(key)
    if (employer === undefined) {
      employer = await findEmployer(db, lead, direct)
      // A lead that names its employer's site or points at a board is checked now, a few at a time; the verifier decides.
      if (!employer && (direct || lead.companyDomain) && verifying < VERIFY_PER_BATCH) {
        verifying++
        const v = await verifyEmployer(db, { name: lead.company, domain: bareDomain(lead.companyDomain), boards: direct ? [direct] : [], source: 'lead' }, deps.verify).catch(() => null)
        if (v?.ok) employer = await findEmployer(db, { ...lead, companyDomain: bareDomain(lead.companyDomain) }, direct)
      }
      employers.set(key, employer ?? null)
    }
    if (!employer) {
      bySource[lead.source] = (bySource[lead.source] ?? 0) + 1
      out.untraced++
      continue
    }

    // Traced: the employer's board already lists the role (the sweep or a check stored it), or the lead is the employer's own posting.
    const title = lead.title.trim()
    const { data: stored } = await db.rpc('employer_roles', { p_employer: employer.id, p_title_norm: typeTitle(title).title_norm })
    const match = ((stored ?? []) as { id: string; location: string | null }[]).find((s) => sameRole(lead.location, s.location))
    if (match) {
      out.jobIds.push(match.id)
    } else if (onEmployer(lead, employer, direct)) {
      toStore.push({ employer, lead })
    } else {
      bySource[lead.source] = (bySource[lead.source] ?? 0) + 1
      out.untraced++
    }
  }

  // The employer's own postings the lead pointed at: stored once for the employer, whoever asked.
  const byEmployer = new Map<string, { employer: Employer; leads: JobLead[] }>()
  for (const s of toStore) {
    const e = byEmployer.get(s.employer.id) ?? { employer: s.employer, leads: [] }
    e.leads.push(s.lead)
    byEmployer.set(s.employer.id, e)
  }
  for (const { employer, leads: mine } of byEmployer.values()) {
    const rows = mine.map((lead) => {
      const job: AtsJob = { title: lead.title.trim(), url: lead.url, externalId: lead.externalId, description: lead.description, location: lead.location ?? undefined, salary: lead.salary ?? undefined, postedAt: lead.postedAt ?? undefined }
      const c = classifyJob({ title: job.title, description: job.description, location: job.location, companyName: employer.name })
      const { company_id: _drop, ...row } = jobRow({ id: employer.id, employer_id: employer.id }, job, job.title, c, lead.source, now)
      return row
    })
    const { error } = await db.rpc('upsert_employer_jobs', { p_employer: employer.id, p_rows: rows })
    if (error) {
      out.errors.push(`store traced leads: ${error.message}`)
      continue
    }
    out.inserted += rows.length
    const { data } = await db.rpc('employer_roles', { p_employer: employer.id, p_external_ids: mine.map((l) => l.externalId) })
    for (const j of (data ?? []) as { id: string }[]) out.jobIds.push(j.id)
  }

  // The person holds what was traced for them.
  if (out.jobIds.length > 0) {
    const { data: p } = await db.from('profiles').select('targets_version').eq('id', userId).maybeSingle()
    const { error } = await db.rpc('add_person_roles', { p_user: userId, p_job_ids: out.jobIds, p_hidden: [], p_targets_version: (p as { targets_version?: number } | null)?.targets_version ?? 0 })
    if (error) out.errors.push(`person roles: ${error.message}`)
  }

  // What was not traced is a number: today's count by source, added to what earlier batches of the day found.
  if (out.untraced > 0) {
    const today = new Date().toISOString().slice(0, 10)
    const { data: have } = await db.from('person_counts').select('reason, n').eq('user_id', userId).eq('day', today).eq('kind', 'untraced').is('employer_id', null).is('company_id', null)
    for (const r of (have ?? []) as { reason: string; n: number }[]) bySource[r.reason] = (bySource[r.reason] ?? 0) + r.n
    const rows = Object.entries(bySource).map(([reason, n]) => ({ employer_id: null, company_id: null, kind: 'untraced', reason, n }))
    const { error } = await db.rpc('set_person_counts', { p_user: userId, p_rows: rows })
    if (error) out.errors.push(`counts: ${error.message}`)
  }
  return out
}
