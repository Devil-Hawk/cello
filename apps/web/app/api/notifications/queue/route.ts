// GET /api/notifications/queue — the review-queue notification bucket.
//
// Every application_drafts row still sitting at status='pending_review' for
// this user, each with the ONE sentence explaining why a human has to look at
// it (lib/notifications/queue.ts#buildQueueItem, which reuses the same
// decideBatchEligibility() the morning batch review is built on — see that
// file's header for why the two must never disagree).
//
// TWO CONSUMERS, ONE ROUTE
//   components/layout/notification-bell.tsx calls this with a small `limit`
//   for the glanceable badge count; components/queue/queue-list.tsx calls it
//   with a large one to render the full, unmissable list on /queue. Both read
//   `count`, not `items.length`, for the true total — `limit` bounds what is
//   RENDERED, never what is reported as pending.
//
// Auth via the cookie-scoped server client; data read through the service-role
// admin client with an explicit user_id filter — application_drafts is not in
// the generated Database type, same convention as app/api/drafts/route.ts and
// app/api/drafts/batch-approve/route.ts.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { buildQueueItem, toQueueVerdict, type QueueDraftRow, type QueueProfileRow } from '@/lib/notifications/queue'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 200

interface CompanyRel {
  name?: string | null
  metadata?: unknown
}

interface JobRel {
  title?: string | null
  url?: string | null
  description?: string | null
  location?: string | null
  companies?: CompanyRel | CompanyRel[] | null
}

interface DraftRowRaw {
  id: string
  job_id: string
  resume_summary: string | null
  answers: unknown
  created_at: string
  jobs?: JobRel | JobRel[] | null
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function toQueueDraftRow(row: DraftRowRaw): QueueDraftRow {
  const job = one(row.jobs)
  const company = one(job?.companies)
  return {
    id: row.id,
    jobId: row.job_id,
    resumeSummary: row.resume_summary,
    answers: row.answers,
    createdAt: row.created_at,
    job: job
      ? {
          title: job.title ?? null,
          url: job.url ?? null,
          description: job.description ?? null,
          location: job.location ?? null,
          companyName: company?.name ?? null,
          companyMetadata: company?.metadata ?? null,
        }
      : null,
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get('limit')) || DEFAULT_LIMIT))

  const admin = createAdminClient()

  // Three independent reads, run together: which is not a dependency chain —
  // the profile is only needed to explain rows that come back from the second
  // query, and the count is the same predicate as the second query without the
  // `limit`, so none of the three can shortcut another.
  const [profileRes, draftsRes, countRes] = await Promise.all([
    admin.from('profiles').select('full_name, email, resume_text, preferences').eq('id', user.id).single(),
    admin
      .from('application_drafts')
      .select(
        'id, job_id, resume_summary, answers, created_at, jobs(title, url, description, location, companies(name, metadata))'
      )
      .eq('user_id', user.id)
      .eq('status', 'pending_review')
      .order('created_at', { ascending: false })
      .limit(limit),
    admin
      .from('application_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'pending_review'),
  ])

  if (draftsRes.error) return NextResponse.json({ error: draftsRes.error.message }, { status: 500 })

  const profile: QueueProfileRow = {
    full_name: (profileRes.data?.full_name as string | null) ?? null,
    email: (profileRes.data?.email as string | null) ?? null,
    resume_text: (profileRes.data?.resume_text as string | null) ?? null,
    preferences: profileRes.data?.preferences,
  }

  const rows = (draftsRes.data ?? []) as unknown as DraftRowRaw[]
  const items = rows.map((row) => buildQueueItem(toQueueDraftRow(row), profile))

  // Verdict badges (smallest honest UI — pass/fail/unjudged, reusing the
  // outreach queue's existing badge idiom): one eval_verdicts lookup for
  // every rendered draft, latest verdict wins when a draft was judged more
  // than once (a regen). Best-effort — a lookup failure degrades to no
  // badge, never to blocking the queue itself.
  if (rows.length > 0) {
    const { data: verdictRows, error: verdictErr } = await admin
      .from('eval_verdicts')
      .select('subject_id, verdict, created_at')
      .eq('user_id', user.id)
      .eq('subject_kind', 'cv_tailor_draft')
      .in(
        'subject_id',
        rows.map((r) => r.id)
      )
      .order('created_at', { ascending: false })
    if (!verdictErr) {
      const latestBySubject = new Map<string, string>()
      for (const v of (verdictRows ?? []) as { subject_id: string; verdict: string }[]) {
        if (!latestBySubject.has(v.subject_id)) latestBySubject.set(v.subject_id, v.verdict)
      }
      for (const item of items) {
        const raw = latestBySubject.get(item.draftId)
        if (raw) item.verdict = toQueueVerdict(raw)
      }
    }
  }

  return NextResponse.json({ items, count: countRes.count ?? items.length })
}
