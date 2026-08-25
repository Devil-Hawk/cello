import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { AnalystAgent } from '@cello/agents'
import type { Company, Job, UserProfile, UserPreferences, MatchDetails, Database } from '@cello/shared'

type ProfileRow = Database['public']['Tables']['profiles']['Row']
type JobRow = Database['public']['Tables']['jobs']['Row']
type CompanyRow = Database['public']['Tables']['companies']['Row']

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only select columns that actually exist. This previously asked for
  // `resume_embedding` and `api_keys` — NEITHER is a real column (pgvector was
  // never installed, and keys live encrypted at preferences.api_keys). PostgREST
  // failed the whole select with 42703, so `profile` came back null and the
  // route reported "No resume uploaded" to users who had a resume on file.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, resume_text, preferences')
    .eq('id', user.id)
    .single()

  if (profileError) {
    console.error('analyze: profile load failed', profileError)
    return NextResponse.json({ error: 'Could not load your profile' }, { status: 500 })
  }

  const typedProfile = profile as Pick<ProfileRow, 'full_name' | 'resume_text' | 'preferences'> | null

  // Parse request body
  const body = await request.json()
  const { jobId } = body

  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
  }

  // Fetch job with company info
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('*, companies(*)')
    .eq('id', jobId)
    .single()

  const typedJob = job as (JobRow & { companies: CompanyRow | null }) | null

  if (jobError || !typedJob) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  if (!typedProfile?.resume_text) {
    return NextResponse.json({ error: 'No resume uploaded' }, { status: 400 })
  }

  // Keys are encrypted under preferences.api_keys; getDecryptedApiKeys is the
  // one supported reader for request context.
  const decrypted = await getDecryptedApiKeys(user.id)
  const apiKeys = {
    openai: decrypted.openai,
    anthropic: decrypted.anthropic,
    openrouter: decrypted.openrouter,
  }

  if (!apiKeys.openai && !apiKeys.anthropic && !apiKeys.openrouter) {
    return NextResponse.json(
      { error: 'Add an OpenRouter API key in Settings → API keys to generate AI insights.' },
      { status: 400 }
    )
  }

  try {
    const agent = new AnalystAgent()

    // Build user profile
    const userProfile: UserProfile = {
      id: user.id,
      email: user.email!,
      fullName: typedProfile.full_name,
      avatarUrl: null,
      resumeText: typedProfile.resume_text,
      // pgvector is not installed in this project; no embedding is stored.
      resumeEmbedding: null,
      preferences: typedProfile.preferences as UserPreferences | null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    // Build job object
    const jobObj: Job = {
      id: typedJob.id,
      companyId: typedJob.company_id,
      title: typedJob.title,
      description: typedJob.description,
      url: typedJob.url,
      location: typedJob.location,
      salaryRange: typedJob.salary_range,
      jobType: typedJob.job_type,
      postedAt: typedJob.posted_at ? new Date(typedJob.posted_at) : null,
      discoveredAt: new Date(typedJob.discovered_at),
      matchScore: typedJob.match_score,
      matchDetails: typedJob.match_details as MatchDetails | null,
      isNew: typedJob.is_new,
    }

    // Build company object if available
    let companyObj: Company | undefined
    if (typedJob.companies) {
      const company = typedJob.companies
      companyObj = {
        id: company.id,
        userId: company.user_id,
        name: company.name,
        domain: company.domain,
        logoUrl: company.logo_url,
        careerUrl: company.career_url,
        scrapeFrequency: company.scrape_frequency,
        lastScrapedAt: company.last_scraped_at ? new Date(company.last_scraped_at) : null,
        isDreamCompany: company.is_dream_company,
        notes: company.notes,
        createdAt: new Date(company.created_at),
      }
    }

    // Execute analysis using agent context
    const result = await agent.execute({
      user: userProfile,
      jobs: [jobObj],
      companies: companyObj ? [companyObj] : undefined,
      apiKeys,
    })

    if (!result.success || !result.data) {
      return NextResponse.json(
        { error: result.error || 'Analysis failed' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      summary: result.data.summary,
      talkingPoints: result.data.talkingPoints,
      companyInsights: result.data.companyInsights,
      interviewTips: result.data.interviewTips,
    })
  } catch (error) {
    console.error('Analyze error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to analyze job' },
      { status: 500 }
    )
  }
}
