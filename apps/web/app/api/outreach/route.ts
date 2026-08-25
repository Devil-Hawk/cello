// GET /api/outreach — list the caller's outreach messages (optionally by status).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { listOutreach } from '@/lib/outreach/store'
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
    const messages = await listOutreach(admin, user.id, { status, limit })
    return NextResponse.json({ ok: true, messages })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to list' }, { status: 500 })
  }
}
