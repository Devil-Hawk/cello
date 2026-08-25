// PATCH/DELETE /api/kb/sources/[id] — edit or remove one knowledge-base
// connector. This is where an apify source's `enabled` flag is flipped on,
// after the user has seen the BYOK/LinkedIn disclosure in the Sources UI.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { deleteSource, getSource, updateSource } from '@/lib/kb/store'
import type { KbSourceConfig } from '@/lib/kb/types'

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const existing = await getSource(admin, user.id, params.id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = (body || {}) as Record<string, unknown>
  const patch: { label?: string | null; config?: KbSourceConfig | null; enabled?: boolean } = {}
  if ('label' in b) patch.label = typeof b.label === 'string' ? b.label.trim().slice(0, 200) || null : null
  if ('config' in b) {
    patch.config = (b.config && typeof b.config === 'object' ? b.config : null) as KbSourceConfig | null
  }
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    patch.enabled = b.enabled
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  try {
    const source = await updateSource(admin, user.id, params.id, patch)
    return NextResponse.json({ ok: true, source })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to update source' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const existing = await getSource(admin, user.id, params.id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await deleteSource(admin, user.id, params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to delete source' }, { status: 500 })
  }
}
