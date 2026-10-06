// What Today reads, as the signed-in person. Every line on the page is a stored
// fact: the clock's record for the check line, SQL counts for the numbers, and the
// person's own rows for the roles. Nothing here asks a model.

import type { SupabaseClient } from '@supabase/supabase-js'
import { checksStatus } from '@/lib/clock/status'
import { parseGmailPermissions } from '@/lib/gmail/permissions'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { readFindNewRoles } from '@/lib/ingest/status'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { readShortlist, todayUtc } from '@/lib/scoring'
import { OnJobs } from '@/lib/scoring/person-roles-query'
import { readNeedsYou } from '@/lib/today/needs-you.stub'
import { checkLine, STAGE_WORDS, type SentRow, type SinceChange } from '@/components/today/logic'
import type { TodayData } from '@/components/today/today-view'
import type { PickItem, RoleItem } from '@/components/roles/types'
import { LIST, toItem, type ListRow } from '../roles/read'

type Db = SupabaseClient<any, any, any>

const BAND = 6
const DAY = 86_400_000

interface AppRow {
  stage: string
  applied_at: string | null
  updated_at: string | null
  jobs: AppJob | AppJob[] | null
}
interface AppJob {
  id: string
  title: string
  still_open: boolean | null
  company_id: string | null
  employer_id: string | null
  companies: { name: string | null; logo_url: string | null; domain: string | null } | { name: string | null; logo_url: string | null; domain: string | null }[] | null
}

const APP_COLUMNS = 'stage, applied_at, updated_at, jobs!inner(id, title, still_open, company_id, employer_id, companies(name, logo_url, domain))'

function whose(a: AppRow) {
  const j = Array.isArray(a.jobs) ? a.jobs[0] : a.jobs
  const c = j ? (Array.isArray(j.companies) ? j.companies[0] : j.companies) : null
  return j ? { jobId: j.id, title: j.title, company: c?.name ?? 'Employer', companyId: j.employer_id ?? j.company_id, domain: c?.domain ?? null, logoUrl: c?.logo_url ?? null, closed: j.still_open === false } : null
}

export async function readToday(db: Db, userId: string, nowMs = Date.now()): Promise<TodayData> {
  const now = new Date(nowMs)
  let admin: Db | null = null
  try {
    admin = createAdminClient()
  } catch {
    admin = null
  }
  const start = `${todayUtc(now)}T00:00:00Z`
  const fortnight = new Date(nowMs - 14 * DAY).toISOString()

  // The earlier visit, and this one stamped, in one call. A first visit has no earlier one.
  const seen = await db.rpc('touch_today_seen')
  const seenAt = typeof seen.data === 'string' ? seen.data : null

  const newest = new OnJobs(db.from('person_roles').select(LIST).is('hidden_reason', null))
  openRolesOnly(newest)

  const [list, today, kept, moved, sentRows, checks, profile, find, keys, needs] = await Promise.all([
    newest.query.order('jobs(posted_at)', { ascending: false, nullsFirst: false }).limit(BAND),
    db.from('person_roles').select('job_id', { count: 'exact', head: true }).is('hidden_reason', null).gte('visible_since', start),
    seenAt ? db.from('person_roles').select('job_id', { count: 'exact', head: true }).is('hidden_reason', null).gt('visible_since', seenAt) : Promise.resolve({ count: 0 }),
    seenAt ? db.from('applications').select(APP_COLUMNS).neq('stage', 'discovered').gt('updated_at', seenAt).order('updated_at', { ascending: false }).limit(5) : Promise.resolve({ data: [] }),
    db.from('applications').select(APP_COLUMNS).neq('stage', 'discovered').gte('applied_at', fortnight).order('applied_at', { ascending: false }).limit(8),
    checksStatus(db, admin, now).catch(() => null),
    db.from('profiles').select('preferences').eq('id', userId).maybeSingle(),
    readFindNewRoles(db as never, now).catch(() => null),
    admin ? loadApiKeys(admin as never, userId).catch(() => null) : Promise.resolve(null),
    readNeedsYou().catch(() => []),
  ])
  if (list.error) return failed(nowMs)

  const items = ((list.data ?? []) as unknown as ListRow[]).map(toItem).filter((i): i is RoleItem => i !== null)
  let band: TodayData['band'] = { kind: 'newest', items }
  try {
    const view = await readShortlist(db as never, userId, todayUtc(now))
    if (view.status === 'ready') {
      const picks: PickItem[] = view.picks.flatMap((p) => {
        const item = p.job ? items.find((i) => i.id === p.job!.id) : undefined
        return item ? [{ ...item, explanation: p.explanation, kind: p.kind }] : []
      })
      if (picks.length > 0) band = { kind: 'picks', items: picks }
    }
  } catch {
    /* picks are off or unreadable: the band stays the newest kept roles */
  }

  const changes: SinceChange[] = ((moved.data ?? []) as AppRow[]).flatMap((a) => {
    const w = whose(a)
    return w ? [{ ...w, text: STAGE_WORDS[a.stage] ?? 'Updated.' }] : []
  })
  const sent: SentRow[] = ((sentRows.data ?? []) as AppRow[]).flatMap((a) => {
    const w = whose(a)
    return w && a.applied_at ? [{ ...w, at: a.applied_at, stage: a.stage }] : []
  })

  const check = checks ? checkLine(checks, nowMs) : null
  const newCount = today.count ?? 0
  const prefs = (profile.data as { preferences?: unknown } | null)?.preferences ?? null

  return {
    state: items.length === 0 && newCount === 0 && !check && sent.length === 0 ? 'first' : 'ready',
    band,
    newCount,
    check,
    working: find?.state === 'checking',
    since: seenAt ? { kept: kept.count ?? 0, changes } : null,
    sent,
    canReadReplies: parseGmailPermissions(prefs).state.monitor.enabled === true,
    hasModel: keys ? canRunLlm(keys) : true,
    needs,
    now: nowMs,
  }
}

function failed(now: number): TodayData {
  return { state: 'failed', band: { kind: 'newest', items: [] }, newCount: 0, check: null, working: false, since: null, sent: [], canReadReplies: false, hasModel: true, needs: [], now }
}
