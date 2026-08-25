// GET  /api/interview          -> { kits: [...] }   (current user's kits)
// GET  /api/interview?id=<id>  -> { kit }            (single kit)
// PATCH /api/interview  { id, status }               -> { kit }  (ready <-> practiced)
//
// Reads are service-role but always filtered to the signed-in user's id.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { getKit, listKits, setStatus, type KitStatus } from '@/lib/interview/store'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const id = request.nextUrl.searchParams.get('id')

  try {
    if (id) {
      const kit = await getKit(admin, user.id, id)
      if (!kit) return NextResponse.json({ error: 'Kit not found' }, { status: 404 })
      return NextResponse.json({ kit })
    }
    const kits = await listKits(admin, user.id, { limit: 100 })
    return NextResponse.json({ kits })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to load kits' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let id = ''
  let status: KitStatus | '' = ''
  try {
    const body = await request.json()
    id = typeof body?.id === 'string' ? body.id : ''
    const s = typeof body?.status === 'string' ? body.status : ''
    status = s === 'ready' || s === 'practiced' ? s : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  if (!status) return NextResponse.json({ error: 'status must be ready or practiced' }, { status: 400 })

  const admin = createAdminClient()
  try {
    const kit = await setStatus(admin, user.id, id, status)
    return NextResponse.json({ ok: true, kit })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to update kit' },
      { status: 500 }
    )
  }
}
