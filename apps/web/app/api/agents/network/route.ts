// POST /api/agents/network — contacts at a company, scored by connection
// strength, plus the ranked referral paths through them.
//
// Pure local graph analysis, no model call — packages/agents' NetworkAgent
// (lib/contacts/network.ts#analyzeNetwork now, langgraph port step 12) never
// called an LLM, so this route needed no metering/journaling to begin with;
// it was flipped only to stop importing the now-deleted-elsewhere
// '@cello/agents' package. Response shape is unchanged:
// {contacts, referralPaths, bestPath}.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeNetwork, type ContactNode } from '@/lib/contacts/network'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { companyId } = body

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('id, name, domain')
    .eq('id', companyId)
    .eq('user_id', user.id)
    .single()

  if (companyError || !company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  }

  try {
    // All of the user's contacts, not just ones already at this company —
    // the network agent finds referral paths through anyone.
    const { data: contactsData } = await supabase
      .from('contacts')
      .select('id, name, title, email, company_id, relationship, last_contact_at')
      .eq('user_id', user.id)

    const contacts: ContactNode[] = (contactsData ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title,
      email: c.email,
      companyId: c.company_id,
      relationship: c.relationship,
      lastContactAt: c.last_contact_at ? new Date(c.last_contact_at) : null,
    }))

    const result = analyzeNetwork({ companyId: company.id, companyName: company.name, companyDomain: company.domain }, contacts)

    return NextResponse.json({
      contacts: result.contacts,
      referralPaths: result.referralPaths,
      bestPath: result.bestPath,
    })
  } catch (error) {
    console.error('Network error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to analyze network' },
      { status: 500 }
    )
  }
}
