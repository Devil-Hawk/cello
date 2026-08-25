// POST /api/gmail/enrich — mine the user's OWN Gmail for recruiter / hiring-
// manager correspondence tied to their tracked companies, and upsert the senders
// into the contacts table. This is the request-context companion to the harness
// `enricher` agent (which cannot access the Gmail provider_token in cron).
//
// NEW FILE under app/api/gmail — the existing sync route is untouched.
// NO LinkedIn / third-party scraping: reads only the signed-in user's mailbox.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { mineRecruiterContacts } from '@/lib/outreach/gmail'
import { hasGmailPermission } from '@/lib/gmail/permissions'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()
  const preferences = (profile?.preferences || {}) as Record<string, unknown>

  // Enrich scans across every tracked company's correspondence — a
  // mailbox-wide read, same as sync, so it's gated on the same "monitor"
  // tier rather than the narrower "read selected shared threads" tier.
  if (!hasGmailPermission(preferences, 'monitor')) {
    return NextResponse.json(
      {
        error: 'Gmail monitoring isn\'t turned on. Enable "Monitor mailbox" under Settings → Connections to let Cello mine contacts from your inbox.',
        needsPermission: 'monitor',
        needsReauth: true,
      },
      { status: 403 }
    )
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.provider_token) {
    return NextResponse.json(
      {
        error: 'Gmail access not available. Connect Gmail in Settings to enable this.',
        needsReauth: true,
      },
      { status: 401 }
    )
  }

  // Optional scope: mine a subset of companies.
  let companyFilter: string[] | null = null
  try {
    const body = await request.json().catch(() => ({}))
    if (Array.isArray(body?.companyIds)) companyFilter = body.companyIds.filter((x: unknown) => typeof x === 'string')
  } catch {
    /* no body — mine all tracked companies */
  }

  let companiesQuery = supabase
    .from('companies')
    .select('id, name, domain')
    .eq('user_id', user.id)
    .not('domain', 'is', null)
  if (companyFilter && companyFilter.length > 0) {
    companiesQuery = companiesQuery.in('id', companyFilter)
  }
  const { data: companies } = await companiesQuery
  const tracked = (companies as { id: string; name: string; domain: string | null }[]) ?? []

  if (tracked.length === 0) {
    return NextResponse.json({ ok: true, mined: 0, created: 0, updated: 0, contacts: [] })
  }

  let mined
  try {
    mined = await mineRecruiterContacts({
      accessToken: session.provider_token,
      companies: tracked,
      maxMessages: 120,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Gmail mining failed' },
      { status: 500 }
    )
  }

  // Load existing contacts to dedupe by email (contacts has no unique email index).
  const { data: existing } = await supabase
    .from('contacts')
    .select('id, email')
    .eq('user_id', user.id)
  const byEmail = new Map<string, string>()
  for (const c of (existing as { id: string; email: string | null }[]) ?? []) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c.id)
  }

  let created = 0
  let updated = 0
  const resultContacts: { id: string; name: string; email: string; company: string; relationship: string }[] = []

  for (const m of mined) {
    const existingId = byEmail.get(m.email)
    if (existingId) {
      await supabase
        .from('contacts')
        .update({ last_contact_at: m.lastContactAt, company_id: m.companyId })
        .eq('id', existingId)
        .eq('user_id', user.id)
      updated++
      resultContacts.push({ id: existingId, name: m.name, email: m.email, company: m.companyName, relationship: m.relationship })
      continue
    }
    const { data: inserted } = await supabase
      .from('contacts')
      .insert({
        user_id: user.id,
        company_id: m.companyId,
        name: m.name,
        email: m.email,
        title: m.title,
        relationship: m.relationship,
        last_contact_at: m.lastContactAt,
        notes: 'Sourced from your Gmail correspondence.',
      })
      .select('id')
      .single()
    if (inserted) {
      byEmail.set(m.email, (inserted as { id: string }).id)
      created++
      resultContacts.push({ id: (inserted as { id: string }).id, name: m.name, email: m.email, company: m.companyName, relationship: m.relationship })
    }
  }

  return NextResponse.json({
    ok: true,
    mined: mined.length,
    created,
    updated,
    contacts: resultContacts,
  })
}
