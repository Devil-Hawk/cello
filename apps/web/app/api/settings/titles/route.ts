// GET /api/settings/titles: the titles the person counts as theirs (corrections and titles they typed), each
// with the role type it counts as. DELETE { title_norm }: Remove. Row level security scopes both to the person.

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getRoleType } from '@/lib/jobs/role-types/taxonomy'

export const dynamic = 'force-dynamic'

export async function GET() {
  // role_type_synonyms is newer than the generated types
  const supabase = (await createClient()) as unknown as SupabaseClient
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { data, error } = await supabase.from('role_type_synonyms').select('title_norm, role_type, source').eq('user_id', user.id).order('created_at', { ascending: false }).limit(200)
  if (error) return NextResponse.json({ error: 'Could not read your titles.' }, { status: 500 })
  return NextResponse.json({
    titles: ((data ?? []) as { title_norm: string; role_type: string; source: string }[]).map((r) => ({ title: r.title_norm, roleType: r.role_type, label: getRoleType(r.role_type)?.label ?? r.role_type, source: r.source })),
  })
}

export async function DELETE(request: NextRequest) {
  // role_type_synonyms is newer than the generated types
  const supabase = (await createClient()) as unknown as SupabaseClient
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const body = (await request.json().catch(() => ({}))) as { title_norm?: unknown }
  if (typeof body.title_norm !== 'string' || !body.title_norm || body.title_norm.length > 160) return NextResponse.json({ error: 'Say which title.' }, { status: 400 })
  const { error } = await supabase.from('role_type_synonyms').delete().eq('user_id', user.id).eq('title_norm', body.title_norm)
  if (error) return NextResponse.json({ error: 'Could not remove that.' }, { status: 500 })
  return NextResponse.json({ removed: true })
}
