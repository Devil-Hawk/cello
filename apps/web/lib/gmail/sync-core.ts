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
import { withTrace } from '@/lib/trace/spans'
import { classifyJob } from '@/lib/jobs/classify'
import type { PipelineStage } from '@/lib/format'
import type { Json } from '@cello/shared'
import type { DecryptedApiKeys } from '@/lib/harness/types'

import { extractInterviewDateTime } from './datetime'
import type { SyncState, ParsedEmail, UnmatchedEmail } from './types'
import { JOB_EMAIL_QUERY, fetchGmailMessages, extractBody, getHeader, extractDomain } from './gmail-api'
import { isPersonalEmailDomain } from './skip-lists'
import { parseEmailWithAI, classifyWithPatterns } from './classify'
import { normalizeCompanyName, findBestJobMatch } from './matching'
import { decideStageTransition, type StageDecision } from './stage'
import { recordStageActivity } from './activity'
import { syncOutreachReplies } from '@/lib/outreach/reply'
import { trackedOnly } from '@/lib/companies/watchlist'
import { DOORS } from '@/lib/pipeline/actors'
import { note, transition } from '@/lib/pipeline/transition'
import { contactKind, linkContact } from '@/lib/contacts/kind'
import { kindOfStatus, saveMessage, verifiedEmployer } from './messages'
import { sendAlert } from '@/lib/notifications/deliver'
import { selfMailer } from '@/lib/notifications/mail'
import { mailAlert } from '@/lib/notifications/quiet'
import { headerVerdict, isRelay, senderEmployerDomain, trustOf } from './trust'

interface CompanyRecord {
  id: string
  name: string
  domain: string | null
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
  createdApplications: string[]
  statusUpdates: Array<{ company: string; status: string; subject: string }>
  unmatched: UnmatchedEmail[]
  /** Job emails whose employer is not a tracked company. Nothing is created for them. */
  unmatchedEmployers: number
  isFirstSync: boolean
}

const ALERT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Run one Gmail sync pass for a single user. Throws on unexpected failure —
 * callers (the route, the cron) are responsible for catching and reporting.
 */
export async function runGmailSyncCore(params: GmailSyncCoreParams): Promise<GmailSyncCoreResult> {
  // One Langfuse trace per sync pass, every inbox.classify generation under it
  // (the 400-observation cap bounds a large scan). Counts only as output:
  // sender names and subjects are other people's data.
  return withTrace(
    createAdminClient(),
    params.userId,
    {
      name: 'sync-gmail',
      outputOf: (r: GmailSyncCoreResult) => ({
        processed: r.processed,
        totalScanned: r.totalScanned,
        createdApplications: r.createdApplications.length,
        statusUpdates: r.statusUpdates.length,
        unmatched: r.unmatched.length,
        unmatchedEmployers: r.unmatchedEmployers,
        isFirstSync: r.isFirstSync,
      }),
    },
    () => runGmailSyncPass(params)
  )
}

async function runGmailSyncPass(params: GmailSyncCoreParams): Promise<GmailSyncCoreResult> {
  const { db, userId, accessToken, apiKeys, preferences } = params
  // The service role writes what the session may not: found applications, messages and the pipeline's events.
  const admin = createAdminClient()

  const syncState: SyncState = (preferences.gmail_sync || {}) as SyncState
  const scannedIds = new Set(syncState.scannedEmailIds || [])
  const isFirstSync = scannedIds.size === 0

  // Only the companies the person tracks: suggested leads are not eligible.
  const { data: existingCompanies } = await trackedOnly(
    db.from('companies').select('id, name, domain, metadata').eq('user_id', userId)
  )

  const companiesByDomain = new Map<string, CompanyRecord>()
  const companiesByName = new Map<string, CompanyRecord>()
  existingCompanies?.forEach((c) => {
    const record: CompanyRecord = {
      id: c.id,
      name: c.name,
      domain: c.domain,
    }
    if (c.domain) companiesByDomain.set(c.domain.toLowerCase(), record)
    companiesByName.set(normalizeCompanyName(c.name), record)
  })

  // STEP 5 Gmail reply bridge: look at the outreach threads themselves (by the
  // thread id stored at send time), independent of the job-application search
  // below. outreach_messages isn't in @cello/shared's generated Database type
  // (see lib/outreach/store.ts's header), so this goes through the untyped
  // service-role admin client every other outreach_messages reader/writer uses
  // regardless of whether `db` is already the admin client (cron) or the
  // session client (route). Never throws; see lib/outreach/reply.ts.
  await syncOutreachReplies({ admin: createAdminClient(), userId, accessToken, apiKeys })

  const maxEmails = isFirstSync ? 1000 : 200

  console.log(`Gmail sync: Fetching up to ${maxEmails} emails (first sync: ${isFirstSync})`)
  const messages = await fetchGmailMessages(accessToken, JOB_EMAIL_QUERY, maxEmails)

  // Filter out already-scanned emails
  const newMessages = messages.filter((msg) => !scannedIds.has(msg.id))
  console.log(`Gmail sync: Processing ${newMessages.length} new emails`)

  const newlyScannedIds: string[] = []
  let unmatchedEmployers = 0
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
      parsed = await parseEmailWithAI(from, subject, body, apiKeys, receivedAt)
    } else {
      parsed = classifyWithPatterns(from, subject, body, receivedAt, msg.payload.calendar)
    }
    // An invite's time is exact; it wins over whatever the model read from the prose.
    if (msg.payload.calendar && (parsed.status === 'interview' || parsed.status === 'screen')) {
      parsed.interviewDateTime = extractInterviewDateTime('', receivedAt, msg.payload.calendar).iso ?? parsed.interviewDateTime
    }

    if (!parsed.isJobRelated) continue

    if (parsed.confidence < 0.6 && parsed.status === 'unknown') {
      continue
    }

    // How far to believe this mail, by code: the sender's domain and its DKIM result. A model's sort of
    // the mail is believed only where a code pattern reads it the same way.
    const verdict = headerVerdict(msg.payload.headers, fromDomain)
    const byPatterns = classifyWithPatterns(from, subject, body, receivedAt)
    const modelSorted = Boolean(apiKeys.openrouter) && !(byPatterns.isJobRelated && byPatterns.status === parsed.status)
    const origin = modelSorted ? 'model' : 'code'
    const prov = modelSorted ? { step: 'inbox.classify', at: receivedAt.toISOString() } : { rule: 'status patterns' }
    const sentAt = receivedAt.toISOString()

    // --- Resolve company: domain match, then normalized-name match. Only a
    // company the person tracks is eligible for job/application attachment. ---
    let matchedCompany: CompanyRecord | null = null
    if (parsed.companyDomain) {
      matchedCompany = companiesByDomain.get(parsed.companyDomain.toLowerCase()) || null
    }
    if (!matchedCompany && parsed.companyName) {
      matchedCompany = companiesByName.get(normalizeCompanyName(parsed.companyName)) || null
    }

    if (!matchedCompany) {
      // Email never creates a company. Unmatched job mail is counted so the
      // card can say so, and the person decides what to track. When the sender
      // is a verified employer's own domain the message is kept, so the person
      // can Confirm an application found there (lib/applications/found.ts).
      const employer = await verifiedEmployer(admin, parsed.companyDomain ?? senderEmployerDomain(fromDomain))
      await saveMessage(admin, {
        userId, gmailMessageId: msg.id, threadId: msg.threadId, applicationId: null, contactId: null, sentAt, fromDomain, subject, body,
        kind: kindOfStatus(parsed.status), origin, prov,
        trust: modelSorted ? 'unconfirmed' : trustOf({ fromDomain, employerDomain: employer?.domain ?? null, verdict }),
        verdict, employerId: employer?.id ?? null, employerOrigin: employer ? (senderEmployerDomain(fromDomain) ? 'code' : 'model') : null, jobTitle: parsed.jobTitle,
      })
      unmatchedEmployers++
      unmatched.push({
        subject,
        from,
        receivedAt: receivedAt.toISOString(),
        reason: 'no tracked company matched this sender',
      })
      continue
    }

    // A relay (an applicant system) signs for its own domain and can name any company in the body, so
    // its mail may only confirm an application, never move a later stage.
    // ponytail: relay confirmations are matched by company and title; a job-id match is the upgrade.
    const trust = modelSorted || (isRelay(fromDomain) && parsed.status !== 'applied') ? 'unconfirmed' : trustOf({ fromDomain, employerDomain: matchedCompany.domain, verdict })

    // --- From here on `matchedCompany` is a company the user actually
    // tracks. Match the email to a specific job by title similarity — never
    // fall back to "whatever job comes back first". ---
    const { data: companyJobs } = await db
      .from('person_jobs')
      .select('id, title')
      .eq('viewer_id', userId)
      .eq('viewer_company_id', matchedCompany.id)
      .limit(500)

    const jobMatch = findBestJobMatch(parsed.jobTitle, companyJobs || [])

    let jobId: string | null = null

    if (jobMatch) {
      jobId = jobMatch.id
    } else if (parsed.jobTitle && trust === 'proven') {
      // No confident match at this company — create a clearly-labelled
      // placeholder using the ACTUAL parsed title, never "Position".
      const classification = classifyJob({
        title: parsed.jobTitle,
        description: `Detected from Gmail: ${subject}`,
        companyName: matchedCompany.name,
      })

      const { data: newJob, error: jobError } = await db
        .from('jobs')
        .insert({
          company_id: matchedCompany.id,
          title: parsed.jobTitle,
          description: `[Unverified — detected from a Gmail message, not scraped from the careers page] ${subject}`,
          url: matchedCompany.domain
            ? `https://${matchedCompany.domain}`
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
          ? `no confident job-title match at "${matchedCompany.name}" (checked ${companyJobs?.length || 0} jobs) and placeholder creation failed`
          : `no job title could be extracted from this email to match or attach at "${matchedCompany.name}"`,
      })
      continue
    }

    // --- Find or create the application, then apply the stage-transition
    // policy (rejected from any stage, no silent terminal regression). ---
    const { data: existingApp } = await db
      .from('applications')
      .select('id, stage, state')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .maybeSingle()

    let applicationId: string
    let decision: StageDecision
    let appState: string | null = null

    if (existingApp) {
      applicationId = existingApp.id
      appState = (existingApp as { state?: string | null }).state ?? null
      // Only mail from a verified sender moves a stage; the rest is recorded and the stage stays.
      decision =
        trust === 'proven'
          ? decideStageTransition(existingApp.stage, parsed.status)
          : { action: 'no_change', fromStage: existingApp.stage, toStage: existingApp.stage, reason: 'the sender could not be verified, so the stage stays as it is' }

      if (decision.action === 'advanced') {
        const nextStage = toPipelineStage(decision.toStage)
        await db
          .from('applications')
          .update({ stage: nextStage, updated_at: new Date().toISOString() })
          .eq('id', applicationId)

        statusUpdates.push({ company: matchedCompany.name, status: nextStage, subject })
      }
    } else {
      if (parsed.status === 'unknown') {
        unmatched.push({
          subject,
          from,
          receivedAt: receivedAt.toISOString(),
          reason: `matched a job at "${matchedCompany.name}" but no application stage was detected to create a new application`,
        })
        continue
      }

      if (trust !== 'proven') {
        unmatched.push({ subject, from, receivedAt: receivedAt.toISOString(), reason: 'the sender could not be verified, so no application was made' })
        continue
      }
      const gmailThreadUrl = `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`
      const initialStage = toPipelineStage(parsed.status)
      // found in email: it waits for the person's Confirm before it counts for anything
      const { data: newApp, error: appError } = await admin
        .from('applications')
        .insert({
          user_id: userId,
          job_id: jobId,
          found_state: 'to_confirm',
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
          reason: `matched a job at "${matchedCompany.name}" but failed to create the application record`,
        })
        continue
      }

      applicationId = newApp.id
      createdApplications.push(matchedCompany.name)
      decision = { action: 'advanced', fromStage: 'discovered', toStage: parsed.status, reason: 'new application created from Gmail' }
    }

    // --- The message, its contact and a line on the application's timeline.
    const addr = /<([^>]+)>/.exec(from)?.[1] ?? from.trim()
    const display = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || null
    const ck = contactKind({ displayName: display, address: addr, subject, body })
    const contactId =
      ck.kind === 'other'
        ? null
        : await linkContact(admin, userId, { name: display, address: addr, kind: ck.kind, agencyName: ck.agencyName, companyId: matchedCompany.id, employerId: null }).catch(() => null)
    await saveMessage(admin, {
      userId, gmailMessageId: msg.id, threadId: msg.threadId, applicationId, contactId, sentAt, fromDomain, subject, body,
      kind: kindOfStatus(parsed.status, ck.kind === 'recruiter' || ck.kind === 'agency_recruiter'), origin, prov, trust, verdict,
      employerId: null, employerOrigin: null, jobTitle: parsed.jobTitle,
    })
    const line = `Mail from ${matchedCompany.name}: ${subject}`.slice(0, 280)
    await note(admin, userId, applicationId, { kind: 'message.received', actor: DOORS.inbox.actor, channel: DOORS.inbox.channel, sentence: line, idempotencyKey: `msg:${msg.id}`, trust, origin, prov, headerVerdict: verdict }).catch(() => undefined)
    // A mail the sender's own domain vouches for that is an offer, an invitation or a reply tells the person, once.
    // Only mail from the last three days: a first sync's backfill or a first run after a gap must not tell the person about old mail.
    const fresh = !isFirstSync && Date.now() - receivedAt.getTime() < ALERT_WINDOW_MS
    const alert = trust === 'proven' && fresh ? mailAlert(parsed.status, ck.kind === 'recruiter' || ck.kind === 'agency_recruiter') : null
    if (alert) {
      await sendAlert({ admin, sendToSelf: selfMailer(admin), now: new Date() }, userId, { kind: alert, subjectId: msg.id, company: matchedCompany.name, role: jobMatch?.title ?? parsed.jobTitle ?? null, url: '/notifications' }).catch(() => undefined)
    }
    if (trust !== 'proven' && parsed.status !== 'unknown') {
      await note(admin, userId, applicationId, { kind: 'stage.suggested', actor: DOORS.inbox.actor, channel: DOORS.inbox.channel, sentence: `A mail says ${parsed.status}. Cello could not verify the sender, so the stage stays.`, idempotencyKey: `suggest:${msg.id}`, trust: 'unconfirmed', origin, prov, headerVerdict: verdict }).catch(() => undefined)
    }
    // The employer's own confirmation of a send the person made: Sent becomes Confirmed.
    if (trust === 'proven' && parsed.status === 'applied' && appState === 'sent') {
      await transition(admin, { applicationId, from: ['sent'], to: 'confirmed', event: { kind: 'submission.confirmed', actor: DOORS.inbox.actor, channel: DOORS.inbox.channel, sentence: `${matchedCompany.name} confirmed it.`, idempotencyKey: `confirmed:${applicationId}`, trust: 'proven', origin: 'code', prov, headerVerdict: verdict } }).catch(() => undefined)
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
      companyId: matchedCompany.id,
      jobId,
      status: parsed.status,
      decision,
      companyName: matchedCompany.name,
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
        trust,
        stage_decision: decision as unknown as Json,
        interview_datetime: parsed.interviewDateTime,
      },
    })

    // Interview/screen detected — this is precisely the case that used to be
    // invisible. Create a follow-up reminder due before the interview.
    if (trust === 'proven' && (parsed.status === 'interview' || parsed.status === 'screen')) {
      const interviewAt = parsed.interviewDateTime ? new Date(parsed.interviewDateTime) : null
      const dueDate =
        interviewAt && !isNaN(interviewAt.getTime())
          ? new Date(Math.max(Date.now(), interviewAt.getTime() - 24 * 60 * 60 * 1000))
          : new Date(Date.now() + 24 * 60 * 60 * 1000)

      const kind = parsed.status === 'screen' ? 'phone screen' : 'interview'
      const note =
        interviewAt && !isNaN(interviewAt.getTime())
          ? `Your ${kind} with ${matchedCompany.name} on ${interviewAt.toLocaleString()} (detected from Gmail: "${subject}")`
          : `${kind[0].toUpperCase()}${kind.slice(1)} detected with ${matchedCompany.name} — check the email for the exact time ("${subject}")`

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
    createdApplications,
    statusUpdates,
    unmatched,
    unmatchedEmployers,
    isFirstSync,
  }
}
