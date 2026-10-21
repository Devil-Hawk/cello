import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { companyRoles, isUuid } from '@/lib/companies'

// GET /api/companies/<employer id>/roles?q=spark   search inside one employer's stored open roles (title, type, description)

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = params
  const q = new URL(request.url).searchParams.get('q') ?? ''
  if (!isUuid(id)) return NextResponse.json({ error: 'Cello does not have that employer.' }, { status: 404 })
  if (q.length > 120) return NextResponse.json({ error: 'Search with at most 120 characters.' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, query: q.trim(), roles: await companyRoles(createAdminClient(), user.id, id, q) })
  } catch {
    return NextResponse.json({ error: 'Could not read the roles right now.' }, { status: 500 })
  }
}
