// GET /api/artifacts?type=&job_id=&limit=&offset=: the person's saved documents (resumes, cover
// letters, emails, dossiers, interview prep, shortlists), newest first. No content here; open one
// with /api/artifacts/[id].

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { ARTIFACT_TYPES, listArtifacts, type ArtifactType } from '@/lib/agents/artifacts'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = request.nextUrl.searchParams
  const type = q.get('type')
  if (type && !(ARTIFACT_TYPES as readonly string[]).includes(type)) return NextResponse.json({ error: 'type must be one of ' + ARTIFACT_TYPES.join(', ') }, { status: 400 })
  const number = (key: string) => {
    const n = Number(q.get(key))
    return Number.isFinite(n) && n >= 0 && q.get(key) !== null ? Math.floor(n) : undefined
  }
  const artifacts = await listArtifacts(createAdminClient(), user.id, {
    type: (type as ArtifactType | null) ?? undefined,
    jobId: q.get('job_id') ?? undefined,
    limit: number('limit'),
    offset: number('offset'),
  })
  return NextResponse.json({ artifacts })
}
