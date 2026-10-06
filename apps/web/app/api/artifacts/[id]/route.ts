// /api/artifacts/[id]
//
// GET   the document and every version of it, newest first, each with the words as text, who wrote
//       it (the person or Cello) and Cello's own check of it.
// POST  { content }  the person's edit, saved as a new version. The content has the same fields as
//       the document's type (a cover letter has `text`; an email has `subject` and `body`).

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { editArtifact } from '@/lib/agents/api'
import { getArtifactRow, listVersions } from '@/lib/agents/artifacts'

export const dynamic = 'force-dynamic'

const NOT_FOUND = { error: 'Not found', fix: 'Open the list of your documents and choose one from it.' }

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const artifact = await getArtifactRow(admin, user.id, params.id)
  if (!artifact) return NextResponse.json(NOT_FOUND, { status: 404 })
  return NextResponse.json({ artifact, versions: await listVersions(admin, user.id, params.id) })
}

const Body = z.object({ content: z.record(z.string(), z.unknown()) })

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body', fix: 'Send { content } with the fields of this kind of document.' }, { status: 400 })

  const out = await editArtifact(createAdminClient(), user.id, params.id, parsed.data.content)
  if (!out.ok) return NextResponse.json({ error: out.error, fix: out.fix }, { status: out.status })
  return NextResponse.json({ version: out.version }, { status: 201 })
}
