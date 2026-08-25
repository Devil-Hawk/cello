import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { NetworkAgent } from '@cello/agents'
import type { Company, Contact, UserProfile, UserPreferences, Database } from '@cello/shared'

type ProfileRow = Database['public']['Tables']['profiles']['Row']
type CompanyRow = Database['public']['Tables']['companies']['Row']
type ContactRow = Database['public']['Tables']['contacts']['Row']

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get user profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, preferences')
    .eq('id', user.id)
    .single()

  const typedProfile = profile as Pick<ProfileRow, 'full_name' | 'preferences'> | null

  // Parse request body
  const body = await request.json()
  const { companyId } = body

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }

  // Fetch company
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .eq('user_id', user.id)
    .single()

  const typedCompany = company as CompanyRow | null

  if (companyError || !typedCompany) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  }

  try {
    // Build user profile
    const userProfile: UserProfile = {
      id: user.id,
      email: user.email!,
      fullName: typedProfile?.full_name ?? null,
      avatarUrl: null,
      resumeText: null,
      resumeEmbedding: null,
      preferences: typedProfile?.preferences as UserPreferences | null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    // Build company object
    const companyObj: Company = {
      id: typedCompany.id,
      userId: typedCompany.user_id,
      name: typedCompany.name,
      domain: typedCompany.domain,
      logoUrl: typedCompany.logo_url,
      careerUrl: typedCompany.career_url,
      scrapeFrequency: typedCompany.scrape_frequency,
      lastScrapedAt: typedCompany.last_scraped_at ? new Date(typedCompany.last_scraped_at) : null,
      isDreamCompany: typedCompany.is_dream_company,
      notes: typedCompany.notes,
      createdAt: new Date(typedCompany.created_at),
    }

    // Fetch all user's contacts (not just at this company - network agent finds paths)
    const { data: contactsData } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', user.id)

    const typedContacts = contactsData as ContactRow[] | null

    const contacts: Contact[] = (typedContacts || []).map((c) => ({
      id: c.id,
      userId: c.user_id,
      companyId: c.company_id,
      name: c.name,
      email: c.email,
      linkedinUrl: c.linkedin_url,
      title: c.title,
      relationship: c.relationship,
      lastContactAt: c.last_contact_at ? new Date(c.last_contact_at) : null,
      notes: c.notes,
      createdAt: new Date(c.created_at),
    }))

    // Create agent and execute
    const agent = new NetworkAgent()
    const result = await agent.execute({
      user: userProfile,
      companies: [companyObj],
      contacts,
    } as import('@cello/agents').AgentContext & { contacts: Contact[] })

    if (!result.success || !result.data) {
      return NextResponse.json(
        { error: result.error || 'Network analysis failed' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      contacts: result.data.contacts,
      referralPaths: result.data.referralPaths,
      bestPath: result.data.bestPath,
    })
  } catch (error) {
    console.error('Network error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to analyze network' },
      { status: 500 }
    )
  }
}
