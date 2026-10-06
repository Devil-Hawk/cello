// Daily-digest composer.
//
// composeDigest(admin, userId) loads a snapshot of stored state and hands it to
// the pure buildDigest (lib/digest/build.ts). No external fetch, no model. It is
// framework-free (takes an injected Supabase client) so it runs in BOTH the
// request context (app/api/digest) and the cron/harness context
// (app/api/harness/cron).
//
// Because the admin (service role) client bypasses RLS, EVERY query here filters
// explicitly by user ownership (user_id, or company_id restricted to the user's
// own companies).

import type { SupabaseClient } from '@supabase/supabase-js'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import { resolveOutreachPreferences } from '@/lib/outreach/types'
import { buildDigest, type DigestState } from './build'
import type { ComposedDigest } from './types'

export { buildDigest, jobReason } from './build'
export type { DigestState } from './build'

const DAY_MS = 24 * 60 * 60 * 1000
const NEW_ROLE_DAYS = 7
const REPLY_DAYS = 14

type Row = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Read everything the digest needs for one user. Never throws on missing data. */
export async function loadDigestState(admin: SupabaseClient, userId: string, now: number = Date.now()): Promise<DigestState> {
  const [{ data: companyData }, { data: profile }] = await Promise.all([
    admin.from('companies').select('id, name').eq('user_id', userId),
    admin.from('profiles').select('preferences').eq('id', userId).single(),
  ])
  const companies = (companyData as { id: string; name: string | null }[] | null) ?? []
  const companyName = new Map(companies.map((c) => [c.id, c.name]))
  const followUpDays = resolveOutreachPreferences((profile?.preferences as Record<string, unknown> | null)?.outreach).followUpDays

  // Outreach: replies, follow-ups that can still be sent, drafts waiting, and the 30-day record.
  const { data: outreachData } = await admin
    .from('outreach_messages')
    .select('id, status, kind, to_name, to_email, company_id, job_id, parent_id, sent_at, replied_at, reply_classification')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(500)
  const outreach = (outreachData as Row[] | null) ?? []
  const hasFollowUp = new Set(outreach.map((m) => str(m.parent_id)).filter((v): v is string => !!v))
  const jobIds = [...new Set(outreach.map((m) => str(m.job_id)).filter((v): v is string => !!v))]
  const titleOf = new Map<string, string>()
  if (jobIds.length > 0) {
    const { data: titles } = await admin.from('person_jobs').select('id, title').eq('viewer_id', userId).in('id', jobIds.slice(0, 500))
    for (const t of (titles as { id: string; title: string }[] | null) ?? []) titleOf.set(t.id, t.title)
  }
  const who = (m: Row) => str(m.to_name) ?? str(m.to_email)
  const company = (m: Row) => (str(m.company_id) ? companyName.get(m.company_id as string) ?? null : null)

  const sentLast30 = outreach.filter((m) => m.status === 'sent' && str(m.sent_at) && now - Date.parse(m.sent_at as string) <= 30 * DAY_MS)
  const replied = (m: Row) => str(m.replied_at) && m.reply_classification !== 'bounce'

  // Drafts waiting for approval.
  const { data: draftData } = await admin.from('application_drafts').select('id').eq('user_id', userId).eq('status', 'pending_review')

  // Roles discovered recently, and everything the user has applied to.
  const { data: appData } = await admin
    .from('applications')
    .select('id, job_id, stage, updated_at, applied_at, jobs(id, title, company_id, employer:company_directory(name))')
    .eq('user_id', userId)
  const apps = (appData as unknown as (Row & { jobs: { id: string; title: string; company_id: string | null; employer: { name: string | null } | null } | null })[] | null) ?? []
  const appliedJobIds = new Set(apps.map((a) => str(a.job_id)).filter((v): v is string => !!v))

  // The roles this person was shown in the last week: their own rows (their want and
  // their chance are on them) with the posting embedded.
  const on = new OnJobs(
    admin
      .from('person_roles')
      .select('chance, want_p, want_reason, jobs!inner(id, title, url, still_open, discovered_at, company_id, employer:company_directory(name))')
      .eq('user_id', userId)
      .is('hidden_reason', null)
  )
  on.gte('discovered_at', new Date(now - NEW_ROLE_DAYS * DAY_MS).toISOString())
  const { data: roleData } = await on.query.order('want_p', { ascending: false, nullsFirst: false }).limit(40)
  type PostingRow = { id: string; title: string; url: string | null; still_open: boolean | null; discovered_at: string | null; company_id: string | null; employer: { name: string | null } | { name: string | null }[] | null }
  const roles: DigestState['roles'] = ((roleData as unknown as { chance: string | null; want_p: number | null; want_reason: string | null; jobs: PostingRow | PostingRow[] | null }[] | null) ?? []).flatMap((r) => {
    const j = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs
    if (!j) return []
    return [
      {
        id: j.id,
        title: j.title,
        company: (j.company_id ? companyName.get(j.company_id) : null) ?? (Array.isArray(j.employer) ? j.employer[0]?.name : j.employer?.name) ?? null,
        url: str(j.url),
        chance: r.chance,
        want: typeof r.want_p === 'number' ? r.want_p : null,
        reason: str(r.want_reason),
        discoveredAt: str(j.discovered_at) ?? new Date(now).toISOString(),
        stillOpen: typeof j.still_open === 'boolean' ? j.still_open : null,
        hasApplication: appliedJobIds.has(j.id),
      },
    ]
  })

  return {
    companyCount: companies.length,
    pendingOutreach: outreach.filter((m) => m.status === 'pending_review').length,
    pendingApplications: ((draftData as unknown[] | null) ?? []).length,
    replies: outreach
      .filter((m) => m.status === 'sent' && replied(m) && m.reply_classification !== 'negative' && now - Date.parse(m.replied_at as string) <= REPLY_DAYS * DAY_MS)
      .map((m) => ({ name: who(m), company: company(m), jobTitle: str(m.job_id) ? titleOf.get(m.job_id as string) ?? null : null, repliedAt: m.replied_at as string })),
    followUps: outreach
      .filter(
        (m) =>
          m.status === 'sent' &&
          m.kind === 'initial' &&
          !str(m.replied_at) &&
          !hasFollowUp.has(m.id as string) &&
          str(m.sent_at) &&
          now - Date.parse(m.sent_at as string) >= followUpDays * DAY_MS
      )
      .map((m) => ({ name: who(m), company: company(m), sentAt: m.sent_at as string })),
    roles,
    applications: apps.map((a) => ({
      id: a.id as string,
      stage: a.stage as string,
      title: a.jobs?.title ?? 'Untitled role',
      company: (a.jobs?.company_id ? companyName.get(a.jobs.company_id) : null) ?? a.jobs?.employer?.name ?? null,
      appliedAt: str(a.applied_at),
      updatedAt: (str(a.updated_at) ?? new Date(now).toISOString()),
    })),
    sentLast30: sentLast30.length,
    repliesLast30: outreach.filter((m) => replied(m) && now - Date.parse(m.replied_at as string) <= 30 * DAY_MS).length,
  }
}

/**
 * Compose today's digest for a user from stored tables only. Never throws on
 * missing data: an empty state gives an empty digest that says what to do next.
 */
export async function composeDigest(admin: SupabaseClient, userId: string): Promise<ComposedDigest> {
  const now = Date.now()
  return buildDigest(await loadDigestState(admin, userId, now), now)
}
