// GET /api/outreach: list the caller's outreach messages (optionally by status),
// each with its stored quality-check verdicts.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { listOutreach } from '@/lib/outreach/store'
import { readStoredVerdicts } from '@/lib/outreach/verdicts'
import type { OutreachStatus } from '@/lib/outreach/types'

export const dynamic = 'force-dynamic'

const STATUSES: OutreachStatus[] = ['pending_review', 'approved', 'sent', 'failed', 'skipped']

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const statusParam = searchParams.get('status')
  const status = statusParam && STATUSES.includes(statusParam as OutreachStatus)
    ? (statusParam as OutreachStatus)
    : undefined
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 100))

  const admin = createAdminClient()
  try {
    const rows = await listOutreach(admin, user.id, { status, limit })
    // Stored judge verdicts ride along so the queue card shows them instead of
    // offering a second paid check for a result that already exists. Only the
    // drafts still awaiting a decision show them, which also keeps the id list
    // in that one query short when Insights asks for 200 rows.
    const verdicts = await readStoredVerdicts(
      admin,
      user.id,
      rows.filter((m) => m.status === 'pending_review' || m.status === 'approved')
    )
    // What the card needs to run the same checks the draft was held to as the
    // user edits: the sign-off name, the company, whether there is real earlier
    // contact, and for a follow-up the email it must be shorter than.
    const pendingRows = rows.filter((m) => m.status === 'pending_review' || m.status === 'approved')
    const ids = (pick: (m: (typeof rows)[number]) => string | null) => [...new Set(pendingRows.map(pick).filter((v): v is string => !!v))]
    const companyIds = ids((m) => m.company_id)
    const contactIds = ids((m) => m.contact_id)
    const parentIds = ids((m) => m.parent_id)
    const [{ data: profile }, { data: companies }, { data: touched }, { data: parents }] = await Promise.all([
      admin.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
      companyIds.length ? admin.from('companies').select('id, name').eq('user_id', user.id).in('id', companyIds) : { data: [] },
      contactIds.length ? admin.from('interactions').select('contact_id').eq('user_id', user.id).in('contact_id', contactIds) : { data: [] },
      parentIds.length ? admin.from('outreach_messages').select('id, body').eq('user_id', user.id).in('id', parentIds) : { data: [] },
    ])
    const senderName = (profile as { full_name?: string | null } | null)?.full_name?.trim() || null
    const companyName = new Map(((companies ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
    const withHistory = new Set(((touched ?? []) as { contact_id: string }[]).map((r) => r.contact_id))
    const parentBody = new Map(((parents ?? []) as { id: string; body: string }[]).map((p) => [p.id, p.body]))
    const messages = rows.map((m) => ({
      ...m,
      verdicts: verdicts.get(m.id) ?? [],
      sender_name: senderName,
      company_name: m.company_id ? (companyName.get(m.company_id) ?? null) : null,
      has_history: m.contact_id ? withHistory.has(m.contact_id) : false,
      parent_body: m.parent_id ? (parentBody.get(m.parent_id) ?? null) : null,
    }))
    return NextResponse.json({ ok: true, messages })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to list' }, { status: 500 })
  }
}
