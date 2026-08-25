import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { CoachAgent } from '@cello/agents'
import type { Application, Company, Contact, Job, UserProfile, UserPreferences, PipelineStage, MatchDetails, Database } from '@cello/shared'

type ProfileRow = Database['public']['Tables']['profiles']['Row']
type ApplicationRow = Database['public']['Tables']['applications']['Row']
type JobRow = Database['public']['Tables']['jobs']['Row']
type CompanyRow = Database['public']['Tables']['companies']['Row']
type ContactRow = Database['public']['Tables']['contacts']['Row']

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get user profile with API keys
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, resume_text, api_keys, preferences')
    .eq('id', user.id)
    .single()

  const typedProfile = profile as Pick<ProfileRow, 'full_name' | 'resume_text' | 'api_keys' | 'preferences'> | null

  // Parse request body
  const body = await request.json()
  const { applicationId } = body

  if (!applicationId) {
    return NextResponse.json({ error: 'applicationId is required' }, { status: 400 })
  }

  // Fetch application with job and company info
  const { data: application, error: appError } = await supabase
    .from('applications')
    .select('*, jobs(*, companies(*))')
    .eq('id', applicationId)
    .eq('user_id', user.id)
    .single()

  type ApplicationWithRelations = ApplicationRow & {
    jobs: (JobRow & { companies: CompanyRow | null }) | null
  }
  const typedApplication = application as ApplicationWithRelations | null

  if (appError || !typedApplication) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 })
  }

  const apiKeys = typedProfile?.api_keys as { openai?: string; anthropic?: string } | undefined

  try {
    // Build user profile
    const userProfile: UserProfile = {
      id: user.id,
      email: user.email!,
      fullName: typedProfile?.full_name ?? null,
      avatarUrl: null,
      resumeText: typedProfile?.resume_text ?? null,
      resumeEmbedding: null,
      preferences: typedProfile?.preferences as UserPreferences | null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    // Build application object
    const appObj: Application = {
      id: typedApplication.id,
      userId: typedApplication.user_id,
      jobId: typedApplication.job_id,
      stage: typedApplication.stage as PipelineStage,
      appliedAt: typedApplication.applied_at ? new Date(typedApplication.applied_at) : null,
      source: typedApplication.source,
      notes: typedApplication.notes,
      resumeVersion: typedApplication.resume_version,
      coverLetter: typedApplication.cover_letter,
      createdAt: new Date(typedApplication.created_at),
      updatedAt: new Date(typedApplication.updated_at),
    }

    // Build job object if available
    let jobObj: Job | undefined
    let companyObj: Company | undefined

    if (typedApplication.jobs) {
      const job = typedApplication.jobs

      jobObj = {
        id: job.id,
        companyId: job.company_id,
        title: job.title,
        description: job.description,
        url: job.url,
        location: job.location,
        salaryRange: job.salary_range,
        jobType: job.job_type,
        postedAt: job.posted_at ? new Date(job.posted_at) : null,
        discoveredAt: new Date(job.discovered_at),
        matchScore: job.match_score,
        matchDetails: job.match_details as MatchDetails | null,
        isNew: job.is_new,
      }

      if (job.companies) {
        companyObj = {
          id: job.companies.id,
          userId: job.companies.user_id,
          name: job.companies.name,
          domain: job.companies.domain,
          logoUrl: job.companies.logo_url,
          careerUrl: job.companies.career_url,
          scrapeFrequency: job.companies.scrape_frequency,
          lastScrapedAt: job.companies.last_scraped_at ? new Date(job.companies.last_scraped_at) : null,
          isDreamCompany: job.companies.is_dream_company,
          notes: job.companies.notes,
          createdAt: new Date(job.companies.created_at),
        }
      }
    }

    // Fetch contacts at the company
    let contacts: Contact[] = []
    if (companyObj) {
      const { data: contactsData } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', user.id)
        .eq('company_id', companyObj.id)

      const typedContacts = contactsData as ContactRow[] | null

      if (typedContacts) {
        contacts = typedContacts.map((c) => ({
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
      }
    }

    // Create agent and execute
    const agent = new CoachAgent()
    const result = await agent.execute({
      user: userProfile,
      applications: [appObj],
      jobs: jobObj ? [jobObj] : undefined,
      companies: companyObj ? [companyObj] : undefined,
      contacts,
      apiKeys,
    } as import('@cello/agents').AgentContext & { contacts: Contact[] })

    if (!result.success || !result.data) {
      return NextResponse.json(
        { error: result.error || 'Coaching failed' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      suggestion: result.data.suggestion,
      draftMessage: result.data.draftMessage,
      suggestedContacts: result.data.suggestedContacts,
    })
  } catch (error) {
    console.error('Coach error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate coaching' },
      { status: 500 }
    )
  }
}
