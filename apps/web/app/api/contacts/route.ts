// GET /api/contacts — list the caller's contacts, optionally scoped to a
// company. Read-only; sourcing/creation lives at POST /api/contacts/source.
//
// Degrades gracefully if supabase/migrations/20260728000007_contact_
// provenance.sql hasn't been applied yet (source/confidence/verified/basis
// columns absent): retries with the pre-migration column set instead of
// 500ing the whole list. See lib/contacts/sources.ts's header for why.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const FULL_COLUMNS = 'id, company_id, name, email, title, linkedin_url, relationship, source, confidence, verified, basis, notes, last_contact_at, created_at'
const BASE_COLUMNS = 'id, company_id, name, email, title, linkedin_url, relationship, notes, last_contact_at, created_at'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const companyId = searchParams.get('companyId')
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 100))

  const build = (columns: string) => {
    let query = supabase.from('contacts').select(columns).eq('user_id', user.id).order('created_at', { ascending: false }).limit(limit)
    if (companyId) query = query.eq('company_id', companyId)
    return query
  }

  let { data, error } = await build(FULL_COLUMNS)
  let provenanceColumnsAvailable = true
  if (error && (error.code === '42703' || /column .* does not exist/i.test(error.message))) {
    provenanceColumnsAvailable = false
    ;({ data, error } = await build(BASE_COLUMNS))
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, contacts: data ?? [], provenanceColumnsAvailable })
}
