// POST /api/gmail/sync — mine the signed-in user's Gmail for job-application
// correspondence and turn it into companies/jobs/applications/activities/
// follow_ups. Pure text-matching + classification logic lives in lib/gmail/*
// (owned alongside this route); this file is the DB-orchestrating layer.
//
// Fixes applied here (see BUILDER-4 task list):
//  1. No more arbitrary `.limit(1)` job attachment — jobs are matched by
//     title similarity (lib/gmail/matching.ts) above a confidence threshold,
//     or a clearly-labelled placeholder job is created from the ACTUAL parsed
//     title. If neither is possible, nothing is attached (see `unmatched`).
//  2. No more inventing tracked companies from arbitrary senders. Applications
//     are only attached to companies the user already tracks (matched by
//     domain, then normalized name). An unrecognized-but-plausible employer is
//     recorded as a `metadata: {suggested:true, source:'gmail'}` company for
//     the user to confirm — never with a fabricated career_url.
//  3. Sender skip list now also excludes ATS/job-board/aggregator domains
//     (lib/gmail/skip-lists.ts) from being used as the employer identity —
//     the real employer is parsed out of the subject/body/display-name
//     instead (lib/gmail/employer.ts).
//  4. Every classified email that resolves to an application gets an
//     `activities` row (this was completely missing before). Idempotent:
//     re-running sync dedupes on `metadata->>'gmail_message_id'`.
//  5. Interview/screen emails get their date/time extracted (LLM first, regex
//     fallback) and produce a `follow_ups` reminder due before the interview.
//  6. Stage transitions go through lib/gmail/stage.ts: rejection is allowed
//     from any non-terminal stage, terminal stages are never silently
//     regressed, and every decision (including "ignored") is recorded on the
//     activity row's metadata.
//  7. The Gmail search query is tightened (lib/gmail/gmail-api.ts) and the
//     response includes `unmatched` so the UI can show what couldn't be
//     classified/attached instead of the route guessing silently.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { classifyJob } from '@/lib/jobs/classify'
import type { PipelineStage } from '@/lib/format'
import type { Json } from '@cello/shared'

import type { SyncState, ParsedEmail, UnmatchedEmail } from '@/lib/gmail/types'
import { JOB_EMAIL_QUERY, fetchGmailMessages, extractBody, getHeader, extractDomain } from '@/lib/gmail/gmail-api'
import { isPersonalEmailDomain } from '@/lib/gmail/skip-lists'
import { parseEmailWithAI, classifyWithPatterns } from '@/lib/gmail/classify'
import { normalizeCompanyName, findBestJobMatch } from '@/lib/gmail/matching'
import { decideStageTransition, type StageDecision } from '@/lib/gmail/stage'
import { activityTypeForStatus, buildActivityContent } from '@/lib/gmail/activity'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface CompanyRecord {
  id: string
  name: string
  domain: string | null
  /** True when this row was auto-created as a suggestion, not user-tracked. */
  suggested: boolean
}

function isSuggestedMetadata(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).suggested === true
  )
}

function isHttpUrl(value: string | null | undefined): value is string {
  return !!value && /^https?:\/\//i.test(value)
}

// The pipeline Kanban (lib/format.ts — a locked contract file owned by other
// builders) only ever renders these 7 stages; anything else silently vanishes
// from every column. Our stage policy can decide "accepted" (offer confirmed
// by the candidate), which has no dedicated column yet, so clamp it to
// "offer" for the persisted applications.stage. The richer "accepted"
// narrative is still captured verbatim on the activity timeline below — only
// the Kanban placement is clamped, nothing is lost.
const RECOGNIZED_PIPELINE_STAGES = new Set<string>([
  'discovered', 'applied', 'screen', 'interview', 'offer', 'ghosted', 'rejected',
])

function toPipelineStage(stage: string): PipelineStage {
  if (RECOGNIZED_PIPELINE_STAGES.has(stage)) return stage as PipelineStage
  if (stage === 'accepted') return 'offer'
  return 'discovered'
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: { session } } = await supabase.auth.getSession()

  // Get sync state / permissions from preferences (read once, reused below —
  // the permission gate needs it before we even look at provider_token).
  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>

  // "Monitor mailbox" is its own opt-in tier now (see lib/gmail/permissions),
  // separate from "send" and "read selected shared threads" — a user who
  // hasn't turned this on shouldn't have Cello scanning their inbox just
  // because a Google session happens to exist.
  if (!hasGmailPermission(preferences, 'monitor')) {
    return NextResponse.json({
      error: 'Gmail monitoring isn\'t turned on. Enable "Monitor mailbox" under Settings → Connections to let Cello scan your inbox for application updates.',
      needsPermission: 'monitor',
      // Also surfaced as needsReauth so existing callers (e.g. the dashboard
      // Gmail sync card) route the user to the same Settings → Connections
      // destination they already know, with the calmer "not connected" tone
      // rather than a red error — this is an unmet precondition, not a fault.
      needsReauth: true,
    }, { status: 403 })
  }

  if (!session?.provider_token) {
    return NextResponse.json({
      error: 'Gmail access not available. Connect Gmail in Settings to enable this.',
      needsReauth: true
    }, { status: 401 })
  }

  // Get API keys for AI parsing (regex fallback is used when absent).
  const apiKeys = await getDecryptedApiKeys(user.id)

  try {
    const syncState: SyncState = (preferences.gmail_sync || {}) as SyncState
    const scannedIds = new Set(syncState.scannedEmailIds || [])
    const isFirstSync = scannedIds.size === 0

    // Get existing companies (including previously-suggested ones, so we
    // don't re-suggest the same sender every sync).
    const { data: existingCompanies } = await supabase
      .from('companies')
      .select('id, name, domain, metadata')
      .eq('user_id', user.id)

    const companiesByDomain = new Map<string, CompanyRecord>()
    const companiesByName = new Map<string, CompanyRecord>()
    existingCompanies?.forEach((c) => {
      const record: CompanyRecord = {
        id: c.id,
        name: c.name,
        domain: c.domain,
        suggested: isSuggestedMetadata(c.metadata),
      }
      if (c.domain) companiesByDomain.set(c.domain.toLowerCase(), record)
      companiesByName.set(normalizeCompanyName(c.name), record)
    })

    const maxEmails = isFirstSync ? 1000 : 200

    console.log(`Gmail sync: Fetching up to ${maxEmails} emails (first sync: ${isFirstSync})`)
    const messages = await fetchGmailMessages(session.provider_token, JOB_EMAIL_QUERY, maxEmails)

    // Filter out already-scanned emails
    const newMessages = messages.filter((msg) => !scannedIds.has(msg.id))
    console.log(`Gmail sync: Processing ${newMessages.length} new emails`)

    const newlyScannedIds: string[] = []
    const suggestedCompanies: string[] = []
    const createdApplications: string[] = []
    const statusUpdates: Array<{ company: string; status: string; subject: string }> = []
    const unmatched: UnmatchedEmail[] = []

    for (const msg of newMessages) {
      newlyScannedIds.push(msg.id)

      const from = getHeader(msg.payload.headers, 'from')
      const subject = getHeader(msg.payload.headers, 'subject')
      const body = extractBody(msg.payload)
      const parsedInternalDate = new Date(parseInt(msg.internalDate, 10))
      const receivedAt = isNaN(parsedInternalDate.getTime()) ? new Date() : parsedInternalDate
      const fromDomain = extractDomain(from)

      // Personal/free-mail senders are never a company — skip outright. ATS
      // and job-board senders (greenhouse.io, linkedin.com, ...) are NOT
      // skipped here: they're processed normally, but parseEmailWithAI /
      // classifyWithPatterns never trust their domain as the employer.
      if (isPersonalEmailDomain(fromDomain)) continue

      let parsed: ParsedEmail
      if (apiKeys.openrouter) {
        parsed = await parseEmailWithAI(from, subject, body, apiKeys.openrouter, receivedAt)
      } else {
        parsed = classifyWithPatterns(from, subject, body, receivedAt)
      }

      if (!parsed.isJobRelated) continue

      if (parsed.confidence < 0.6 && parsed.status === 'unknown') {
        continue
      }

      // --- Resolve company: domain match, then normalized-name match. Only
      // an already-TRACKED (non-suggested) company is eligible for job/
      // application attachment. ---
      let matchedCompany: CompanyRecord | null = null
      if (parsed.companyDomain) {
        matchedCompany = companiesByDomain.get(parsed.companyDomain.toLowerCase()) || null
      }
      if (!matchedCompany && parsed.companyName) {
        matchedCompany = companiesByName.get(normalizeCompanyName(parsed.companyName)) || null
      }

      const trackedCompany = matchedCompany && !matchedCompany.suggested ? matchedCompany : null

      if (!trackedCompany) {
        // No tracked company. Record a suggestion instead of inventing a
        // tracked one — but only once per sender (skip if we already have a
        // suggestion or tracked company matching this domain/name), only with
        // a real (non-fabricated) URL, and only above a real confidence bar.
        if (!matchedCompany && (parsed.companyName || parsed.companyDomain) && parsed.confidence >= 0.6) {
          const suggestionName = parsed.companyName || parsed.companyDomain!
          const careerUrl = parsed.companyDomain
            ? `https://${parsed.companyDomain}`
            : isHttpUrl(parsed.careerPageUrl) ? parsed.careerPageUrl : null

          if (careerUrl) {
            const { data: newCompany, error: companyError } = await supabase
              .from('companies')
              .insert({
                user_id: user.id,
                name: suggestionName,
                domain: parsed.companyDomain,
                career_url: careerUrl,
                logo_url: parsed.companyDomain
                  ? `https://www.google.com/s2/favicons?domain=${parsed.companyDomain}&sz=128`
                  : null,
                metadata: {
                  suggested: true,
                  source: 'gmail',
                  firstSeenSubject: subject,
                  gmailMessageId: msg.id,
                } satisfies Json,
              })
              .select('id')
              .single()

            if (!companyError && newCompany) {
              const record: CompanyRecord = {
                id: newCompany.id,
                name: suggestionName,
                domain: parsed.companyDomain,
                suggested: true,
              }
              suggestedCompanies.push(suggestionName)
              if (parsed.companyDomain) companiesByDomain.set(parsed.companyDomain.toLowerCase(), record)
              companiesByName.set(normalizeCompanyName(suggestionName), record)
            }
          }
        }

        unmatched.push({
          subject,
          from,
          receivedAt: receivedAt.toISOString(),
          reason: matchedCompany
            ? `"${matchedCompany.name}" is only a suggested company — track it to attach applications`
            : 'no tracked company matched this sender; recorded as a suggestion if a real domain/name was found',
        })
        continue
      }

      // --- From here on `trackedCompany` is a company the user actually
      // tracks. Match the email to a specific job by title similarity — never
      // fall back to "whatever job comes back first". ---
      const { data: companyJobs } = await supabase
        .from('jobs')
        .select('id, title')
        .eq('company_id', trackedCompany.id)
        .limit(500)

      const jobMatch = findBestJobMatch(parsed.jobTitle, companyJobs || [])

      let jobId: string | null = null

      if (jobMatch) {
        jobId = jobMatch.id
      } else if (parsed.jobTitle) {
        // No confident match at this company — create a clearly-labelled
        // placeholder using the ACTUAL parsed title, never "Position".
        const classification = classifyJob({
          title: parsed.jobTitle,
          description: `Detected from Gmail: ${subject}`,
          companyName: trackedCompany.name,
        })

        const { data: newJob, error: jobError } = await supabase
          .from('jobs')
          .insert({
            company_id: trackedCompany.id,
            title: parsed.jobTitle,
            description: `[Unverified — detected from a Gmail message, not scraped from the careers page] ${subject}`,
            url: trackedCompany.domain
              ? `https://${trackedCompany.domain}`
              : isHttpUrl(parsed.careerPageUrl)
                ? parsed.careerPageUrl
                : `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
            discovered_at: receivedAt.toISOString(),
            source: 'gmail_sync',
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
        unmatched.push({
          subject,
          from,
          receivedAt: receivedAt.toISOString(),
          reason: parsed.jobTitle
            ? `no confident job-title match at "${trackedCompany.name}" (checked ${companyJobs?.length || 0} jobs) and placeholder creation failed`
            : `no job title could be extracted from this email to match or attach at "${trackedCompany.name}"`,
        })
        continue
      }

      // --- Find or create the application, then apply the stage-transition
      // policy (rejected from any stage, no silent terminal regression). ---
      const { data: existingApp } = await supabase
        .from('applications')
        .select('id, stage')
        .eq('user_id', user.id)
        .eq('job_id', jobId)
        .maybeSingle()

      let applicationId: string
      let decision: StageDecision

      if (existingApp) {
        applicationId = existingApp.id
        decision = decideStageTransition(existingApp.stage, parsed.status)

        if (decision.action === 'advanced') {
          const nextStage = toPipelineStage(decision.toStage)
          await supabase
            .from('applications')
            .update({ stage: nextStage, updated_at: new Date().toISOString() })
            .eq('id', applicationId)

          statusUpdates.push({ company: trackedCompany.name, status: nextStage, subject })
        }
      } else {
        if (parsed.status === 'unknown') {
          unmatched.push({
            subject,
            from,
            receivedAt: receivedAt.toISOString(),
            reason: `matched a job at "${trackedCompany.name}" but no application stage was detected to create a new application`,
          })
          continue
        }

        const gmailThreadUrl = `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`
        const initialStage = toPipelineStage(parsed.status)
        const { data: newApp, error: appError } = await supabase
          .from('applications')
          .insert({
            user_id: user.id,
            job_id: jobId,
            stage: initialStage,
            applied_at: receivedAt.toISOString(),
            source: 'gmail_sync',
            notes: JSON.stringify({
              gmail_thread_id: msg.threadId,
              gmail_thread_url: gmailThreadUrl,
              detected_from_subject: subject,
            }),
          })
          .select('id')
          .single()

        if (appError || !newApp) {
          unmatched.push({
            subject,
            from,
            receivedAt: receivedAt.toISOString(),
            reason: `matched a job at "${trackedCompany.name}" but failed to create the application record`,
          })
          continue
        }

        applicationId = newApp.id
        createdApplications.push(trackedCompany.name)
        decision = { action: 'advanced', fromStage: 'discovered', toStage: parsed.status, reason: 'new application created from Gmail' }
      }

      // --- Activity + follow-up. Idempotent: skip if this exact Gmail
      // message already produced an activity on this application. ---
      const { data: existingActivity } = await supabase
        .from('activities')
        .select('id')
        .eq('application_id', applicationId)
        .eq('metadata->>gmail_message_id', msg.id)
        .maybeSingle()

      if (existingActivity) continue

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
          gmail_message_id: msg.id,
          gmail_thread_id: msg.threadId,
          from,
          subject,
          stage_decision: decision as unknown as Json,
          interview_datetime: parsed.interviewDateTime,
        } satisfies Json,
        occurred_at: receivedAt.toISOString(),
      })

      // Interview/screen detected — this is precisely the case that used to
      // be invisible. Create a follow-up reminder due before the interview.
      if (parsed.status === 'interview' || parsed.status === 'screen') {
        const interviewAt = parsed.interviewDateTime ? new Date(parsed.interviewDateTime) : null
        const dueDate =
          interviewAt && !isNaN(interviewAt.getTime())
            ? new Date(Math.max(Date.now(), interviewAt.getTime() - 24 * 60 * 60 * 1000))
            : new Date(Date.now() + 24 * 60 * 60 * 1000)

        const kind = parsed.status === 'screen' ? 'phone screen' : 'interview'
        const note =
          interviewAt && !isNaN(interviewAt.getTime())
            ? `Prep for your ${kind} with ${trackedCompany.name} on ${interviewAt.toLocaleString()} (detected from Gmail: "${subject}")`
            : `${kind[0].toUpperCase()}${kind.slice(1)} detected with ${trackedCompany.name} — check the email for the exact time ("${subject}")`

        await supabase.from('follow_ups').insert({
          application_id: applicationId,
          due_date: dueDate.toISOString(),
          note,
        })
      }
    }

    // Save sync state
    const allScannedIds = [...scannedIds, ...newlyScannedIds]
    const trimmedIds = allScannedIds.slice(-5000)

    await supabase
      .from('profiles')
      .update({
        preferences: {
          ...preferences,
          gmail_sync: {
            lastSyncDate: new Date().toISOString(),
            scannedEmailIds: trimmedIds
          }
        }
      })
      .eq('id', user.id)

    return NextResponse.json({
      success: true,
      message: isFirstSync
        ? `Initial scan complete! Processed ${newMessages.length} emails`
        : `Synced ${newMessages.length} new emails`,
      processed: newMessages.length,
      totalScanned: allScannedIds.length,
      // Kept as `createdCompanies` for the existing dashboard card — these are
      // suggested companies (metadata.suggested=true), not auto-tracked ones.
      createdCompanies: suggestedCompanies,
      createdApplications,
      statusUpdates,
      unmatched,
      isFirstSync
    })

  } catch (error) {
    // Structured + (if configured) Sentry-reported — see logApiError's own
    // doc. `extra` is IDs only: never the email/company/job content this
    // route processes.
    logApiError('gmail/sync', error, { userId: user.id })
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to sync Gmail'
    }, { status: 500 })
  }
}
