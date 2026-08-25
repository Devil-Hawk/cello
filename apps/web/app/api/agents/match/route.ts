import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm, MissingKeyError } from '@/lib/harness/llm'
import { scoreJobWithLlm, buildMatchDetails } from '@/lib/harness/agents/matcher'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import type { LlmRunner } from '@/lib/harness/types'
import type { Database, Json } from '@cello/shared'

type ProfileRow = Database['public']['Tables']['profiles']['Row']
type JobRow = Database['public']['Tables']['jobs']['Row']

/**
 * On-demand single-job match scoring for the jobs page. The "bulk" calculate-all
 * action on the jobs page is a client-side loop of this same single-job POST
 * (see calculateAllMatches in app/(app)/jobs/page.tsx) — there is no separate
 * batch payload to support here.
 *
 * Uses the SAME scoring routine as the harness cron digest and autopilot
 * (lib/harness/agents/matcher.ts's scoreJobWithLlm/buildMatchDetails) so a job
 * scored from this page and one scored by the background agents produce
 * byte-identical match_details. Deliberately bypasses the Targeting prefilter
 * those background paths apply — the user explicitly clicked "match this job",
 * so we score exactly the job asked for regardless of targeting/quality.
 *
 * Previously read profiles.api_keys, a column that does not exist in prod
 * (schema keys live at profiles.preferences.api_keys, encrypted) — that 42703
 * error made every on-demand match silently behave as "no key" forever. Fixed
 * by going through the same loadApiKeys() the harness uses.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const jobId = typeof (body as { jobId?: unknown })?.jobId === 'string' ? (body as { jobId: string }).jobId : null

  if (!jobId) {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('resume_text')
    .eq('id', user.id)
    .single()
  const typedProfile = profile as Pick<ProfileRow, 'resume_text'> | null
  const resume = (typedProfile?.resume_text ?? '').trim()

  if (!resume) {
    return NextResponse.json(
      { error: 'No resume uploaded — add one in Settings first.', skippedReason: 'no-resume' },
      { status: 400 }
    )
  }

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('id, title, description, location, companies(name)')
    .eq('id', jobId)
    .single()

  type JobWithCompany = Pick<JobRow, 'id' | 'title' | 'description' | 'location'> & {
    companies: { name: string | null } | { name: string | null }[] | null
  }
  const typedJob = job as JobWithCompany | null

  if (jobError || !typedJob) {
    return NextResponse.json(
      { error: 'Job not found', skippedReason: 'job-not-found' },
      { status: 404 }
    )
  }

  // Keys live encrypted at profiles.preferences.api_keys — loadApiKeys works
  // against any SupabaseClient (request-scoped is fine, we're reading our own row).
  // PROVIDER GATE ALIGNMENT: the harness only ever calls OpenRouter, so this
  // must gate on canRunLlm(apiKeys) — never openai/anthropic presence alone —
  // and explain the gap when the account has the wrong provider's key.
  const apiKeys = await loadApiKeys(supabase, user.id)
  if (!canRunLlm(apiKeys)) {
    return NextResponse.json(
      { error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' },
      { status: 400 }
    )
  }

  const companies = typedJob.companies
  const companyName = Array.isArray(companies) ? companies[0]?.name : companies?.name

  try {
    const llm: LlmRunner = (opts) => callLlm(apiKeys, opts)
    const { verdict } = await scoreJobWithLlm(llm, resume, {
      id: typedJob.id,
      title: typedJob.title,
      description: typedJob.description,
      location: typedJob.location,
      companyName: companyName ?? null,
    })
    const matchDetails = buildMatchDetails(verdict)

    await supabase
      .from('jobs')
      .update({ match_score: verdict.score, match_details: matchDetails as unknown as Json })
      .eq('id', jobId)

    return NextResponse.json(matchDetails)
  } catch (error) {
    if (error instanceof MissingKeyError) {
      return NextResponse.json(
        { error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' },
        { status: 400 }
      )
    }
    console.error('Match error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to match job',
        skippedReason: 'scoring-failed',
      },
      { status: 500 }
    )
  }
}
