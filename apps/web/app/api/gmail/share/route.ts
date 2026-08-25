// POST /api/gmail/share — the "read selected shared threads" permission's
// actual mechanism. The user pastes/forwards ONE email's text in directly;
// this route never talks to Gmail and never needs a Google access token —
// that's the whole point of this tier (see lib/gmail/permissions.ts).
//
// Deliberately smaller than /api/gmail/sync: it only attaches to a company
// the user ALREADY tracks (no speculative "suggested company" creation —
// the user just pasted this in, so if it's a new employer they can track it
// directly), and it processes exactly the one submitted message. The
// classify/match/stage/activity pieces are the same pure helpers sync uses,
// reused as-is rather than duplicated with different behavior.

import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { classifyJob } from '@/lib/jobs/classify'
import type { PipelineStage } from '@/lib/format'
import type { Json } from '@cello/shared'

import { hasGmailPermission } from '@/lib/gmail/permissions'
import { validateShareInput, type RawShareInput } from '@/lib/gmail/share'
import { extractDomain } from '@/lib/gmail/gmail-api'
import { isPersonalEmailDomain } from '@/lib/gmail/skip-lists'
import { parseEmailWithAI, classifyWithPatterns } from '@/lib/gmail/classify'
import { normalizeCompanyName, findBestJobMatch } from '@/lib/gmail/matching'
import { decideStageTransition, type StageDecision } from '@/lib/gmail/stage'
import { activityTypeForStatus, buildActivityContent } from '@/lib/gmail/activity'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function isHttpUrl(value: string | null | undefined): value is string {
  return !!value && /^https?:\/\//i.test(value)
}

const RECOGNIZED_PIPELINE_STAGES = new Set<string>([
  'discovered', 'applied', 'screen', 'interview', 'offer', 'ghosted', 'rejected',
])

function toPipelineStage(stage: string): PipelineStage {
  if (RECOGNIZED_PIPELINE_STAGES.has(stage)) return stage as PipelineStage
  if (stage === 'accepted') return 'offer'
  return 'discovered'
}

/** Stable per-user dedupe key for a pasted thread — there's no Gmail message ID to key off. */
function shareHash(userId: string, subject: string, from: string, receivedAtIso: string): string {
  return createHash('sha256').update(`${userId}\n${subject}\n${from}\n${receivedAtIso}`).digest('hex').slice(0, 32)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>

  if (!hasGmailPermission(preferences, 'readShared')) {
    return NextResponse.json(
      {
        error: 'Sharing a thread isn\'t turned on. Enable "Read selected shared threads" under Settings → Connections first.',
        needsPermission: 'readShared',
      },
      { status: 403 }
    )
  }

  let rawBody: RawShareInput
  try {
    rawBody = (await request.json()) as RawShareInput
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validated = validateShareInput(rawBody)
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }
  const { subject, from, body, receivedAt } = validated.value

  const fromDomain = extractDomain(from)
  if (isPersonalEmailDomain(fromDomain)) {
    return NextResponse.json({
      ok: true,
      matched: false,
      reason: 'The sender looks like a personal email address, not a company — nothing to attach this to.',
    })
  }

  try {
    const apiKeys = await getDecryptedApiKeys(user.id)
    const parsed = apiKeys.openrouter
      ? await parseEmailWithAI(from, subject, body, apiKeys.openrouter, receivedAt)
      : classifyWithPatterns(from, subject, body, receivedAt)

    if (!parsed.isJobRelated) {
      return NextResponse.json({
        ok: true,
        matched: false,
        reason: parsed.reasoning || 'This doesn\'t look like job-application correspondence.',
      })
    }

    const { data: existingCompanies } = await supabase
      .from('companies')
      .select('id, name, domain, metadata')
      .eq('user_id', user.id)

    const isSuggested = (metadata: unknown) =>
      !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).suggested === true

    let trackedCompany: { id: string; name: string; domain: string | null } | null = null
    for (const c of existingCompanies ?? []) {
      if (isSuggested(c.metadata)) continue
      if (parsed.companyDomain && c.domain && c.domain.toLowerCase() === parsed.companyDomain.toLowerCase()) {
        trackedCompany = c
        break
      }
    }
    if (!trackedCompany && parsed.companyName) {
      const target = normalizeCompanyName(parsed.companyName)
      trackedCompany = (existingCompanies ?? []).find(
        (c) => !isSuggested(c.metadata) && normalizeCompanyName(c.name) === target
      ) ?? null
    }

    if (!trackedCompany) {
      return NextResponse.json({
        ok: true,
        matched: false,
        reason: parsed.companyName || parsed.companyDomain
          ? `"${parsed.companyName || parsed.companyDomain}" isn't a company you're tracking yet — track it first, then share this thread again.`
          : 'Could not identify the employer from this thread.',
      })
    }

    const { data: companyJobs } = await supabase
      .from('jobs')
      .select('id, title')
      .eq('company_id', trackedCompany.id)
      .limit(500)

    const jobMatch = findBestJobMatch(parsed.jobTitle, companyJobs || [])
    let jobId: string | null = jobMatch?.id ?? null

    if (!jobId && parsed.jobTitle) {
      const classification = classifyJob({
        title: parsed.jobTitle,
        description: `Detected from a shared thread: ${subject}`,
        companyName: trackedCompany.name,
      })
      const { data: newJob, error: jobError } = await supabase
        .from('jobs')
        .insert({
          company_id: trackedCompany.id,
          title: parsed.jobTitle,
          description: `[Unverified — detected from a thread you shared, not scraped from the careers page] ${subject}`,
          url: trackedCompany.domain
            ? `https://${trackedCompany.domain}`
            : isHttpUrl(parsed.careerPageUrl)
              ? parsed.careerPageUrl
              : `mailto:${from}`,
          discovered_at: receivedAt.toISOString(),
          source: 'gmail_share',
          job_function: classification.jobFunction,
          seniority: classification.seniority,
          language: classification.language,
          is_remote: classification.isRemote,
        })
        .select('id')
        .single()
      if (!jobError && newJob) jobId = newJob.id
    }

    if (!jobId) {
      return NextResponse.json({
        ok: true,
        matched: false,
        reason: parsed.jobTitle
          ? `No confident job-title match at "${trackedCompany.name}" and a placeholder job couldn't be created.`
          : `No job title could be extracted to match or attach at "${trackedCompany.name}".`,
      })
    }

    const { data: existingApp } = await supabase
      .from('applications')
      .select('id, stage')
      .eq('user_id', user.id)
      .eq('job_id', jobId)
      .maybeSingle()

    let applicationId: string
    let created = false
    let decision: StageDecision

    if (existingApp) {
      applicationId = existingApp.id
      decision = decideStageTransition(existingApp.stage, parsed.status)
      if (decision.action === 'advanced') {
        await supabase
          .from('applications')
          .update({ stage: toPipelineStage(decision.toStage), updated_at: new Date().toISOString() })
          .eq('id', applicationId)
      }
    } else {
      if (parsed.status === 'unknown') {
        return NextResponse.json({
          ok: true,
          matched: false,
          reason: `Matched a job at "${trackedCompany.name}" but no application stage was detected to create a new application.`,
        })
      }
      const { data: newApp, error: appError } = await supabase
        .from('applications')
        .insert({
          user_id: user.id,
          job_id: jobId,
          stage: toPipelineStage(parsed.status),
          applied_at: receivedAt.toISOString(),
          source: 'gmail_share',
          notes: JSON.stringify({ shared_thread_subject: subject }),
        })
        .select('id')
        .single()
      if (appError || !newApp) {
        return NextResponse.json({
          ok: true,
          matched: false,
          reason: `Matched a job at "${trackedCompany.name}" but failed to create the application record.`,
        })
      }
      applicationId = newApp.id
      created = true
      decision = { action: 'advanced', fromStage: 'discovered', toStage: parsed.status, reason: 'new application created from a shared thread' }
    }

    const hash = shareHash(user.id, subject, from, receivedAt.toISOString())
    const { data: existingActivity } = await supabase
      .from('activities')
      .select('id')
      .eq('application_id', applicationId)
      .eq('metadata->>share_hash', hash)
      .maybeSingle()

    if (existingActivity) {
      return NextResponse.json({
        ok: true,
        matched: true,
        alreadyProcessed: true,
        applicationId,
        company: trackedCompany.name,
      })
    }

    const activityType = activityTypeForStatus(parsed.status, decision)
    const content = buildActivityContent({
      status: parsed.status,
      decision,
      companyName: trackedCompany.name,
      jobTitle: jobMatch?.title || parsed.jobTitle || 'this role',
      subject,
      reasoning: parsed.reasoning,
      interviewDateTime: parsed.interviewDateTime,
    })

    await supabase.from('activities').insert({
      application_id: applicationId,
      type: activityType,
      title: content.title,
      description: content.description,
      metadata: {
        share_hash: hash,
        source: 'gmail_share',
        from,
        subject,
        stage_decision: decision as unknown as Json,
        interview_datetime: parsed.interviewDateTime,
      } satisfies Json,
      occurred_at: receivedAt.toISOString(),
    })

    if (parsed.status === 'interview' || parsed.status === 'screen') {
      const interviewAt = parsed.interviewDateTime ? new Date(parsed.interviewDateTime) : null
      const dueDate =
        interviewAt && !isNaN(interviewAt.getTime())
          ? new Date(Math.max(Date.now(), interviewAt.getTime() - 24 * 60 * 60 * 1000))
          : new Date(Date.now() + 24 * 60 * 60 * 1000)
      const kind = parsed.status === 'screen' ? 'phone screen' : 'interview'
      const note =
        interviewAt && !isNaN(interviewAt.getTime())
          ? `Prep for your ${kind} with ${trackedCompany.name} on ${interviewAt.toLocaleString()} (from a shared thread: "${subject}")`
          : `${kind[0].toUpperCase()}${kind.slice(1)} detected with ${trackedCompany.name} — check the thread for the exact time ("${subject}")`
      await supabase.from('follow_ups').insert({ application_id: applicationId, due_date: dueDate.toISOString(), note })
    }

    return NextResponse.json({
      ok: true,
      matched: true,
      created,
      applicationId,
      company: trackedCompany.name,
      stage: decision.toStage,
      decision: decision.action,
    })
  } catch (error) {
    logApiError('gmail/share', error, { userId: user.id })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process the shared thread' },
      { status: 500 }
    )
  }
}
