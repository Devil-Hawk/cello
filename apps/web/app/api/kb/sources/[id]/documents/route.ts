// GET/POST /api/kb/sources/[id]/documents — list a source's indexed documents,
// or add one directly. This is the paste connector's real entry point: "user
// pastes text -> chunk + index" happens here, not via /sync (a paste source
// has no upstream to re-fetch — see lib/kb/connectors/paste.ts).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { getSource, listDocuments, recordSync } from '@/lib/kb/store'
import { indexPasteDocument } from '@/lib/kb/connectors/paste'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const source = await getSource(admin, user.id, params.id)
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const documents = await listDocuments(admin, user.id, { sourceId: source.id, limit: 100 })
  return NextResponse.json({ ok: true, documents })
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const source = await getSource(admin, user.id, params.id)
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (source.kind !== 'paste') {
    return NextResponse.json(
      { error: `"${source.kind}" sources are populated by Sync, not by adding a document directly.` },
      { status: 400 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const b = (body || {}) as Record<string, unknown>
  const content = typeof b.content === 'string' ? b.content : ''
  const title = typeof b.title === 'string' ? b.title : undefined
  const documentId = typeof b.documentId === 'string' ? b.documentId : undefined

  const outcome = await indexPasteDocument(admin, user.id, source, { content, title, documentId })
  if (outcome.status !== 'synced') {
    return NextResponse.json({ error: outcome.message }, { status: 400 })
  }

  try {
    await recordSync(admin, user.id, source.id)
  } catch (e) {
    console.error('[kb/sources/documents] recordSync failed:', e)
  }

  return NextResponse.json({
    ok: true,
    documentsWritten: outcome.documentsWritten,
    chunksWritten: outcome.chunksWritten,
    message: outcome.message,
  })
}
