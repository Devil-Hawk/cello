import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { companyPage, isUuid } from '@/lib/companies'

// GET /api/companies/<employer id>   one employer: its head, the person's follow, the count by type, the roles they hold.
// The id is the directory's (company_directory.id), not the follow row's.

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = params
  if (!isUuid(id)) return NextResponse.json({ error: 'Cello does not have that employer.' }, { status: 404 })
  try {
    const page = await companyPage(createAdminClient(), user.id, id)
    if (!page) return NextResponse.json({ error: 'Cello does not have that employer.' }, { status: 404 })
    return NextResponse.json({ ok: true, ...page })
  } catch {
    return NextResponse.json({ error: 'Could not read that employer right now.' }, { status: 500 })
  }
}
