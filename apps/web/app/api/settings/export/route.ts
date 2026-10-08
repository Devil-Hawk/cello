// GET /api/settings/export: the person's own records as one JSON file: applications, people, the headers of their
// mail with those people, drafts, reactions and what Cello made. Read with the person's own session, so a row that
// is not theirs cannot appear. Keys, tokens and stored passwords are in none of these tables.
// ponytail: 5,000 rows a table; upgrade to a streamed zip if anyone has more.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const EXPORT_TABLES = ['applications', 'contacts', 'contact_applications', 'messages', 'outreach_messages', 'role_reactions', 'artifacts'] as const

export async function GET(_request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // the generated types do not list every table
  const db = supabase as unknown as SupabaseClient
  const out: Record<string, unknown[]> = {}
  const left: string[] = []
  for (const table of EXPORT_TABLES) {
    const { data, error } = await db.from(table).select('*').eq('user_id', user.id).limit(5000)
    if (error) left.push(table)
    else out[table] = data ?? []
  }
  const body = JSON.stringify({ exported_at: new Date().toISOString(), not_included: left, ...out }, null, 2)
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cello-export.json"',
      'Cache-Control': 'no-store',
    },
  })
}
