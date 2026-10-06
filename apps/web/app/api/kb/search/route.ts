// GET /api/kb/search?q=...&limit=...&company=<id> — ranked full-text search over
// Your material, the signed-in user's own sources that Cello may use (searchKb() ->
// the search_material() RPC). Pages Cello fetched itself are never returned.
// `company` keeps one company's documents.
//
// The copilot's search_kb tool (lib/harness/copilot-tools.ts) calls searchKb()
// directly rather than hitting this HTTP route — this endpoint is for the
// Sources UI (and any other client-side caller) to query the same index.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { formatKbContext, searchKb } from '@/lib/kb/store'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const query = (searchParams.get('q') || '').trim()
  const limitParam = searchParams.get('limit')
  const company = searchParams.get('company')
  const companyId = company && /^[0-9a-f-]{36}$/i.test(company) ? company : undefined
  const limit = limitParam ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 12)) : undefined
  if (!query) return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 })

  const admin = createAdminClient()
  try {
    const hits = await searchKb(admin, user.id, query, { limit, companyId })
    return NextResponse.json({
      ok: true,
      count: hits.length,
      hits,
      context: hits.length > 0 ? formatKbContext(hits) : '',
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Search failed' }, { status: 500 })
  }
}
