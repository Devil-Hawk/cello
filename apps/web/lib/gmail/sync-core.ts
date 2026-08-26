// The per-user Gmail sync CORE — pure move out of app/api/gmail/sync/route.ts
// (see that file's own header for the full history of what this pipeline
// fixes). This is the orchestration lib/gmail/* logic drives; the route is
// now a thin session-authed wrapper, and app/api/gmail/cron/route.ts drives
// the exact same function with the admin client + a stored refresh token so
// sync runs on a schedule instead of only on a dashboard button click.
//
// Deliberately takes `db` as a plain Supabase client (not typed to a
// generic) — recordStageActivity/recordInteraction already do the same, and
// callers pass either the session-scoped client (route) or the service-role
// admin client (cron); both satisfy the shape this file uses.
//
// Everything auth/permission/token related stays OUT of this file on
// purpose: the caller resolves `accessToken` (session or refreshed) and
// `apiKeys` (session-context or admin-context loader) before calling in, so
// this file has nothing to ask "is this a demo" or "is monitor enabled"
// about — see lib/access/demo-chokepoints.test.ts's KEY_TAKING_MODEL_PLUMBING
// doctrine for why a file handed its keys stays exempt from the model-key
// guard scan rather than re-deriving them.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { classifyJob } from '@/lib/jobs/classify'
import type { PipelineStage } from '@/lib/format'
import type { Json } from '@cello/shared'
import type { DecryptedApiKeys } from '@/lib/harness/types'

import type { SyncState, ParsedEmail, UnmatchedEmail } from './types'
import { JOB_EMAIL_QUERY, fetchGmailMessages, extractBody, getHeader, extractDomain } from './gmail-api'
import { isPersonalEmailDomain } from './skip-lists'
import { parseEmailWithAI, classifyWithPatterns } from './classify'
import { normalizeCompanyName, findBestJobMatch } from './matching'
import { decideStageTransition, classifyReply, type StageDecision } from './stage'
import { recordStageActivity } from './activity'
import { recordOutreachReply } from '@/lib/outreach/store'

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

export interface GmailSyncCoreParams {
  /** The per-request or admin Supabase client for companies/jobs/applications/activities/follow_ups/profiles. */
  db: SupabaseClient
  userId: string
  /** A live Gmail access token — session's provider_token or a freshly refreshed one. */
  accessToken: string
  apiKeys: DecryptedApiKeys
  /** The CALLER's already-read `preferences` blob (drives the permission/sync-state read). */
  preferences: Record<string, unknown>
}

export interface GmailSyncCoreResult {
  success: true
  message: string
  processed: number
  totalScanned: number
  /** Kept as `createdCompanies` for the existing dashboard card — these are suggested companies (metadata.suggested=true), not auto-tracked ones. */
  createdCompanies: string[]
  createdApplications: string[]
  statusUpdates: Array<{ company: string; status: string; subject: string }>
  unmatched: UnmatchedEmail[]
  isFirstSync: boolean
}

/**
 * Run one Gmail sync pass for a single user. Throws on unexpected failure —
 * callers (the route, the cron) are responsible for catching and reporting.
 */
export async function runGmailSyncCore(params: GmailSyncCoreParams): Promise<GmailSyncCoreResult> {
  const { db, userId, accessToken, apiKeys, preferences } = params

  const syncState: SyncState = (preferences.gmail_sync || {}) as SyncState
  const scannedIds = new Set(syncState.scannedEmailIds || [])
  const isFirstSync = scannedIds.size === 0

  // Get existing companies (including previously-suggested ones, so we don't
  // re-suggest the same sender every sync).
  const { data: existingCompanies } = await db
    .from('companies')
    .select('id, name, domain, metadata')
    .eq('user_id', userId)

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

  // STEP 5 Gmail reply bridge: preload the set of Gmail thread ids this user
  // still has an un-replied outreach message on, so the per-message loop
  // below can check thread membership in memory instead of running a wasted
  // outreach_messages lookup for every one of up to 1000 emails.
  // outreach_messages isn't in @cello/shared's generated Database type (see
  // lib/outreach/store.ts's header), so this goes through the same untyped
  // service-role admin client every other outreach_messages reader/writer
  // uses — regardless of whether `db` above is already the admin client
  // (cron) or the session client (route).
  const admin = createAdminClient()
  const { data: unrepliedOutreach } = await admin
    .from('outreach_messages')
    .select('gmail_thread_id')
    .eq('user_id', userId)
    .not('gmail_thread_id', 'is', null)
    .is('replied_at', null)
  const trackedThreadIds = new Set(
    ((unrepliedOutreach as { gmail_thread_id: string }[] | null) || []).map((r) => r.gmail_thread_id)
  )

  const maxEmails = isFirstSync ? 1000 : 200

  console.log(`Gmail sync: Fetching up to ${maxEmails} emails (first sync: ${isFirstSync})`)
  const messages = await fetchGmailMessages(accessToken, JOB_EMAIL_QUERY, maxEmails)

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
    // Exception: a message on a thread we're tracking for an outreach reply
    // must still reach the bridge below even from a personal domain — a
    // contact replying from a personal address is still a real reply.
    const isTrackedReplyThread = trackedThreadIds.has(msg.threadId)
    if (isPersonalEmailDomain(fromDomain) && !isTrackedReplyThread) continue

    let parsed: ParsedEmail
    if (apiKeys.openrouter) {
      parsed = await parseEmailWithAI(from, subject, body, apiKeys.openrouter, receivedAt)
    } else {
      parsed = classifyWithPatterns(from, subject, body, receivedAt)
    }

    // STEP 5 Gmail reply bridge: independent of the job-application pipeline
    // below — an outreach reply ("sounds good, let's talk Tuesday") often
    // isn't job-application-related by that classifier's own standard, but
    // it still answers a tracked outreach thread. Reuses the SAME
    // parsed.status the job pipeline already computed rather than
    // classifying twice.
    if (isTrackedReplyThread) {
      await recordOutreachReply(admin, {
        userId,
        gmailThreadId: msg.threadId,
        gmailMessageId: msg.id,
        classification: classifyReply(from, subject, parsed.status),
        occurredAt: receivedAt.toISOString(),
      })
    }

    if (!parsed.isJobRelated) continue

    if (parsed.confidence < 0.6 && parsed.status === 'unknown') {
      continue
    }

    // --- Resolve company: domain match, then normalized-name match. Only an
    // already-TRACKED (non-suggested) company is eligible for job/
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
          const { data: newCompany, error: companyError } = await db
            .from('companies')
            .insert({
              user_id: userId,
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
    const { data: companyJobs } = await db
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

      const { data: newJob, error: jobError } = await db
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
    const { data: existingApp } = await db
      .from('applications')
      .select('id, stage')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .maybeSingle()

    let applicationId: string
    let decision: StageDecision

    if (existingApp) {
      applicationId = existingApp.id
      decision = decideStageTransition(existingApp.stage, parsed.status)

      if (decision.action === 'advanced') {
        const nextStage = toPipelineStage(decision.toStage)
        await db
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
      const { data: newApp, error: appError } = await db
        .from('applications')
        .insert({
          user_id: userId,
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

    // --- Activity + follow-up. Idempotent: skip if this exact Gmail message
    // already produced an activity on this application. ---
    const { data: existingActivity } = await db
      .from('activities')
      .select('id')
      .eq('application_id', applicationId)
      .eq('metadata->>gmail_message_id', msg.id)
      .maybeSingle()

    if (existingActivity) continue

    await recordStageActivity(db, {
      userId,
      applicationId,
      companyId: trackedCompany.id,
      jobId,
      status: parsed.status,
      decision,
      companyName: trackedCompany.name,
      jobTitle: jobMatch?.title || parsed.jobTitle || 'this role',
      subject,
      reasoning: parsed.reasoning,
      interviewDateTime: parsed.interviewDateTime,
      occurredAt: receivedAt.toISOString(),
      metadata: {
        gmail_message_id: msg.id,
        gmail_thread_id: msg.threadId,
        from,
        subject,
        stage_decision: decision as unknown as Json,
        interview_datetime: parsed.interviewDateTime,
      },
    })

    // Interview/screen detected — this is precisely the case that used to be
    // invisible. Create a follow-up reminder due before the interview.
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

      await db.from('follow_ups').insert({
        application_id: applicationId,
        due_date: dueDate.toISOString(),
        note,
      })
    }
  }

  // Save sync state. Re-read `preferences` fresh here rather than reusing the
  // pre-mint snapshot the caller passed in: getGmailAccessToken may have just
  // self-healed an invalid_grant in its own DB write (clearing refreshToken,
  // setting revokedAt, disabling monitor), and a stale snapshot would
  // silently resurrect all of that. Merge into the current gmail_sync rather
  // than replacing it wholesale, so refreshToken/revokedAt survive every
  // successful sync instead of being wiped the moment this write lands.
  const allScannedIds = [...scannedIds, ...newlyScannedIds]
  const trimmedIds = allScannedIds.slice(-5000)

  const { data: freshProfile } = await db
    .from('profiles')
    .select('preferences')
    .eq('id', userId)
    .single()
  const freshPreferences = (freshProfile?.preferences || {}) as Record<string, unknown>
  const freshSyncState = (freshPreferences.gmail_sync || {}) as SyncState

  await db
    .from('profiles')
    .update({
      preferences: {
        ...freshPreferences,
        gmail_sync: {
          ...freshSyncState,
          lastSyncDate: new Date().toISOString(),
          scannedEmailIds: trimmedIds
        }
      }
    })
    .eq('id', userId)

  return {
    success: true,
    message: isFirstSync
      ? `Initial scan complete! Processed ${newMessages.length} emails`
      : `Synced ${newMessages.length} new emails`,
    processed: newMessages.length,
    totalScanned: allScannedIds.length,
    createdCompanies: suggestedCompanies,
    createdApplications,
    statusUpdates,
    unmatched,
    isFirstSync,
  }
}
