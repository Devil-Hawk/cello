// What the record reads, as the signed-in person: their own person_roles row with
// the posting embedded (a role they cannot read returns nothing), and the few rows
// that say what they have done with this employer. Counts come from SQL.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { visaFromCuratedList } from '@/lib/dossier/visa'
import { resolveConstraints } from '@/lib/scoring/constraints'
import { RequirementsSchema } from '@/lib/jobs/requirements'
import type { RequirementItem, TypeProv } from '@/lib/jobs/relevance-types'
import { readFit } from '@/lib/record/fit.stub'
import { FIT_COLUMNS } from '@/lib/scoring'
import { parseFit } from '@/lib/scoring/read'
import { resolveTargeting } from '@/lib/targeting'
import { NOT_FOR_ME_REASONS } from '@/components/roles/reactions'
import { TYPE_OPTIONS, toItem, type ListRow } from '../read'
import { pastedLine, sponsorshipLines, statusSentence, whyKept, whyType } from '@/components/roles/record/logic'
import type { RecordData, RecordHistoryItem, RecordPerson } from '@/components/roles/record/record-view'
import type { PassReason, Reaction } from '@/lib/scoring/types'

type Db = SupabaseClient<any, any, any>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COLUMNS =
  `job_id, saved_at, hidden_reason, visible_since, checked_at, via, role_type, ${FIT_COLUMNS}, ` +
  'jobs!inner(id, title, description, description_md, description_state, description_source, apply_url, requirements, url, location, salary_range, posted_at, seniority, job_function, is_remote, country, still_open, legit_label, employer_id, company_id, source_tier, role_type, type_origin, type_prov, companies(name, logo_url, domain))'

const reasonLabel = (r: string | null) => NOT_FOR_ME_REASONS.find((x) => x.reason === r)?.label ?? null

/** One role as its record shows it, or null when the person has no row for it (the page then says not found). */
export async function readRecord(db: Db, userId: string, id: string): Promise<RecordData | null> {
  if (!UUID.test(id)) return null
  const { data, error } = await db.from('person_roles').select(COLUMNS).eq('job_id', id).maybeSingle()
  if (error || !data) return null
  const row = data as unknown as ListRow & { checked_at: string | null }
  const job = (Array.isArray(row.jobs) ? row.jobs[0] : row.jobs)!
  const role = toItem(row)
  if (!role) return null

  const [reaction, application, profile, counts, apps, passes, contacts] = await Promise.all([
    db.from('role_reactions').select('reaction, reason').eq('job_id', id).maybeSingle(),
    db.from('applications').select('stage, applied_at').eq('job_id', id).maybeSingle(),
    db.from('profiles').select('preferences').eq('id', userId).maybeSingle(),
    db.rpc('role_counts', { p_by: 'employer' }),
    job.company_id
      ? db.from('applications').select('stage, applied_at, created_at, jobs!inner(title, company_id)').eq('jobs.company_id', job.company_id).neq('job_id', id).limit(20)
      : Promise.resolve({ data: [] }),
    db.from('role_reactions').select('reason, job_title, updated_at').eq('reaction', 'not_for_me').eq('company_name', role.company).neq('job_id', id).limit(20),
    job.company_id ? db.from('contacts').select('id, name, title, relationship, basis, verified').eq('company_id', job.company_id).limit(10) : Promise.resolve({ data: [] }),
  ])

  const prefs = (profile.data as { preferences?: unknown } | null)?.preferences ?? null
  const constraints = resolveConstraints(prefs)
  const targets = resolveTargeting(prefs)
  // The posting as the employer wrote it, whole; a role read before the reader kept it falls back to the plain text.
  const description = job.description_md ?? job.description ?? ''
  const requirements = RequirementsSchema.safeParse(job.requirements)
  const items: RequirementItem[] = requirements.success ? ((requirements.data.items ?? []) as RequirementItem[]) : []
  const fit = readFit(items)
  const key = job.employer_id ?? job.company_id
  const forYou = (counts.data as { key: string; n: number }[] | null)?.find((c) => c.key === key)?.n ?? null

  let open: number | null = null
  if (job.employer_id) {
    try {
      const d = await createAdminClient().from('company_directory').select('open_count').eq('id', job.employer_id).maybeSingle()
      open = (d.data as { open_count: number | null } | null)?.open_count ?? null
    } catch {
      open = null
    }
  }

  const app = application.data as { stage: string; applied_at: string | null } | null
  const r = reaction.data as { reaction: Reaction; reason: PassReason | null } | null
  const history: RecordHistoryItem[] = [
    ...(((apps.data ?? []) as unknown as { stage: string; applied_at: string | null; created_at: string; jobs: { title: string } | { title: string }[] }[]).map((a) => {
      const title = Array.isArray(a.jobs) ? a.jobs[0]?.title : a.jobs?.title
      return { at: a.applied_at ?? a.created_at, text: a.stage === 'discovered' ? `You saved ${title}.` : `You applied to ${title}. Status: ${a.stage}.` }
    })),
    ...(((passes.data ?? []) as { reason: string | null; job_title: string; updated_at: string }[]).map((p) => ({
      at: p.updated_at,
      text: `You passed on ${p.job_title}${reasonLabel(p.reason) ? `: ${reasonLabel(p.reason)}` : ''}.`,
    }))),
  ].sort((a, b) => b.at.localeCompare(a.at))

  const people: RecordPerson[] = ((contacts.data ?? []) as { id: string; name: string; title: string | null; relationship: string | null; basis: string | null; verified: boolean }[]).map((c) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    how: c.relationship ?? c.basis ?? (c.verified ? 'Verified address' : null),
  }))

  return {
    role: { ...role, reaction: r ? { reaction: r.reaction, reason: r.reason } : null },
    url: job.apply_url ?? job.url ?? null,
    description,
    partial: job.description_md != null ? job.description_state === 'partial' || job.description_state === 'none' : undefined,
    tier: job.source_tier ?? null,
    checkedAt: row.checked_at,
    place: job.location ?? null,
    remote: job.is_remote ?? null,
    status: statusSentence(app ? { stage: app.stage, appliedAt: app.applied_at } : null),
    why: whyKept({ roleType: role.type, jobFunction: job.job_function ?? null, seniority: job.seniority ?? null, isRemote: job.is_remote ?? null, country: job.country ?? null }, { ...targets, roleTypes: targets.role_types ?? [] }),
    typeWhy: whyType(role.type, (job.type_prov ?? null) as TypeProv | null),
    pasted: pastedLine(role.pasted, role.type, targets.role_types ?? []),
    typeOptions: TYPE_OPTIONS,
    fit,
    kinds: Object.fromEntries(items.map((i) => [i.id, i.kind])),
    // ponytail: no route stores a correction until K17b's roles.correct_evidence is on main, so Correct is not offered.
    correctUrl: null,
    chanceFit: parseFit({ id: job.id, ...row } as Parameters<typeof parseFit>[0]),
    sponsorship: sponsorshipLines(constraints.needsSponsorship, visaFromCuratedList(role.company) === 'likely', description),
    employer: { open, forYou },
    people,
    history,
  }
}
