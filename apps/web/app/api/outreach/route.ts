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
    const messages = rows.map((m) => ({ ...m, verdicts: verdicts.get(m.id) ?? [] }))
    return NextResponse.json({ ok: true, messages })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to list' }, { status: 500 })
  }
}
