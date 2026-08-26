// Fill a fresh demo profile with a workspace worth demoing.
//
// WHY THIS EXISTS
//   An access code signs its holder into an ISOLATED demo account — a real
//   Supabase auth user with a real profiles row, so the RLS policies that
//   already exist keep them away from the owner's job search and every feature
//   works without a read-only shim. The cost of that isolation is that the
//   account starts completely empty: no companies, no jobs, no pipeline, no
//   resume. Every page would open on its "nothing here yet" card. This module
//   is what makes the demo account look like someone has been using it.
//
// THE THREE PROPERTIES THAT MATTER
//   IDEMPOTENT   Redeeming the same code twice must not double the workspace.
//                Every row id is derived from (demo user, row key) — see
//                fixtures/ids.ts — so "seed again" is an upsert on the primary
//                key, and it uses ignore-duplicates so a second run does not
//                clobber what the demo user has already done in-session.
//   DETERMINISTIC  No Math.random anywhere. The only non-constant input is
//                `now`, which anchors the relative timestamps (a demo issued in
//                October should still show jobs posted "3 days ago"), and it is
//                injectable so the fixture is unit-testable.
//   HARMLESS     Every employer, person, domain and address is fictional and
//                unroutable, and the demo profile is capped at $1 of AI spend
//                so a demo cannot burn the owner's allowance.
//
// REQUIRES supabase/migrations/20260803000002_access_codes.sql to have been
// applied: this writes profiles.is_demo, which that migration adds.

import type { SupabaseClient } from '@supabase/supabase-js'

import { markdownToPlainText } from '@/lib/resume/markdown'
import { DEFAULT_TEMPLATE_ID } from '@/lib/resume/templates'
import { toResumeContentJson } from '@/lib/resume/types'

import {
  buildJobDescription,
  buildMatchDetails,
  careerUrl,
  companyBySlug,
  contactBySlug,
  DEMO_AGENT_RUN,
  DEMO_APPLICATIONS,
  DEMO_COMPANIES,
  DEMO_CONTACTS,
  DEMO_DOSSIERS,
  DEMO_DRAFTS,
  DEMO_FOLLOW_UPS,
  DEMO_INTERVIEW_KITS,
  DEMO_JOBS,
  DEMO_OUTREACH,
  DEMO_PERSONA,
  DEMO_PREFERENCES,
  DEMO_RESUME_MARKDOWN,
  demoUuid,
  externalIdFor,
  jobBySlug,
  jobUrl,
  monogramLogo,
} from './fixtures'

/**
 * The demo profile's monthly AI allowance, in USD.
 *
 * lib/harness/spend.ts reads `preferences.budget.monthlyUsd` at the single LLM
 * choke point and REFUSES the call once `spentUsd >= monthlyUsd`. One dollar is
 * enough to score a batch of jobs and tailor a resume — enough to show that the
 * feature is real — and small enough that a demo cannot cost the owner anything
 * that matters. The product default is $10 (DEFAULT_MONTHLY_USD); a demo gets a
 * tenth of it.
 */
export const DEMO_MONTHLY_USD = 1

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Thrown when the target profile does not look like a fresh demo account. */
export class NotADemoProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotADemoProfileError'
  }
}

// ---------------------------------------------------------------------------
// Time helpers — every seeded timestamp is relative to one injected `now`
// ---------------------------------------------------------------------------

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

function hoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * HOUR_MS).toISOString()
}

function hoursFromNow(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * HOUR_MS).toISOString()
}

// ---------------------------------------------------------------------------
// Preferences (the budget cap lives here)
// ---------------------------------------------------------------------------

/** Current UTC billing month, mirroring lib/harness/spend.ts's currentPeriod(). */
function currentPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Merge the demo preferences onto whatever the profile already has.
 *
 * TWO THINGS HERE ARE SECURITY DECISIONS, NOT STYLE:
 *
 *   1. `spentUsd` IS PRESERVED, NEVER RESET. Re-running the seeder is the same
 *      event as re-redeeming a code, and a demo user can re-enter their code as
 *      many times as they like. If a re-seed zeroed the spend counter, entering
 *      the code again would be a one-keystroke way to refill the allowance and
 *      the cap would bound nothing at all.
 *
 *   2. THE CAP ONLY EVER GOES DOWN. If a profile somehow already carries a
 *      LOWER cap than the demo default, the lower number wins. Seeding must
 *      never be a way to raise a spending limit.
 *
 * RELATIONSHIP TO lib/access/guardrails.ts. That module owns PROVISIONING —
 * the preferences a demo profile is first created with (pinned provider,
 * revoked Gmail grants, api_keys allowlist) — and this owns RE-SEEDING. The two
 * agree on the $1 figure. Everything already on the row is spread through
 * untouched here, so no guardrail that module forces can be loosened by a
 * re-seed: `provider`, `gmail_permissions`, `api_keys` and `autopilot` survive
 * verbatim, and the only key this writes on top (`outreach`) keeps
 * autoSend: false. The one behaviour that deliberately differs is the spend
 * ledger: provisioning resets it (correct — the workspace is new), and this
 * never does (correct — re-entering a code must not refill the allowance).
 */
export function buildDemoPreferences(
  existing: Record<string, unknown> | null | undefined,
  now: Date = new Date()
): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? existing : {}
  const rawBudget = (base as { budget?: unknown }).budget
  const budget = (rawBudget && typeof rawBudget === 'object' ? rawBudget : {}) as Record<string, unknown>

  const existingCap = typeof budget.monthlyUsd === 'number' && budget.monthlyUsd > 0 ? budget.monthlyUsd : null
  const existingSpent = typeof budget.spentUsd === 'number' && budget.spentUsd > 0 ? budget.spentUsd : 0
  const existingPeriod = typeof budget.periodStart === 'string' && budget.periodStart ? budget.periodStart : null

  return {
    ...base,
    ...DEMO_PREFERENCES,
    budget: {
      periodStart: existingPeriod ?? currentPeriod(now),
      spentUsd: existingSpent,
      monthlyUsd: existingCap == null ? DEMO_MONTHLY_USD : Math.min(DEMO_MONTHLY_USD, existingCap),
    },
  }
}

// ---------------------------------------------------------------------------
// The pure builder
// ---------------------------------------------------------------------------

/** One table's worth of rows, in dependency order. */
export interface DemoBatch {
  table: string
  rows: Record<string, unknown>[]
  /**
   * True when a failure leaves the demo unusable and the seeder should abort.
   * False for the surfaces that merely degrade to an empty state — losing the
   * interview kits is a worse demo, losing the jobs is no demo at all.
   */
  required: boolean
  /** Primary-key column the idempotent upsert below conflicts on. Defaults
   *  to 'id' — every table here uses that except trace_spans, whose row
   *  identity is `span_id` (matching that table's own vocabulary — see its
   *  migration's header). */
  conflictColumn?: string
}

export interface DemoWorkspace {
  /** Fields written onto the existing profiles row (never an insert — the auth trigger made it). */
  profile: { full_name: string; resume_text: string; is_demo: true }
  /** Address used ONLY when the profile has no email of its own. */
  fallbackEmail: string
  batches: DemoBatch[]
}

/**
 * Every row the demo workspace consists of, as plain data.
 *
 * Pure: no database, no clock of its own, no randomness. Given the same
 * (demoUserId, now) it returns byte-identical rows, which is what lets the
 * fixture be asserted in a unit test rather than eyeballed in a browser.
 */
export function buildDemoWorkspace(demoUserId: string, now: Date = new Date()): DemoWorkspace {
  if (!demoUserId) throw new Error('buildDemoWorkspace: demoUserId is required')

  const id = (key: string) => demoUuid(demoUserId, key)

  // --- companies -----------------------------------------------------------
  const companyIdBySlug = new Map<string, string>()
  const companyRows = DEMO_COMPANIES.map((company) => {
    const rowId = id(`company:${company.slug}`)
    companyIdBySlug.set(company.slug, rowId)
    return {
      id: rowId,
      user_id: demoUserId,
      name: company.name,
      domain: company.domain,
      logo_url: monogramLogo(company.name, company.tone),
      career_url: careerUrl(company),
      scrape_frequency: 60,
      last_scraped_at: hoursBefore(now, company.scrapedHoursAgo),
      is_dream_company: company.isDream,
      notes: `${company.blurb} Fictional employer seeded for a Cello demo.`,
      created_at: daysBefore(now, company.addedDaysAgo),
      // Deliberately NOT `{ ats: { provider, token } }`: a fabricated board
      // token would send lib/ats/index.ts refreshCompany() off to a real
      // provider's API with nonsense credentials the moment someone clicks
      // Refresh. `demo` is inert — nothing reads it, and it labels the row.
      metadata: { demo: true },
    }
  })

  // --- jobs ----------------------------------------------------------------
  const jobIdBySlug = new Map<string, string>()
  const jobRows = DEMO_JOBS.map((job) => {
    const company = companyBySlug(job.companySlug)
    const rowId = id(`job:${job.slug}`)
    jobIdBySlug.set(job.slug, rowId)

    const postedAt = daysBefore(now, job.postedDaysAgo)
    // Discovered a couple of hours after it was posted — always in the past,
    // because every postedDaysAgo in the fixture is at least 1.
    const discoveredAt = new Date(Date.parse(postedAt) + 2 * HOUR_MS).toISOString()

    return {
      id: rowId,
      company_id: companyIdBySlug.get(job.companySlug)!,
      title: job.title,
      description: buildJobDescription(job, company),
      url: jobUrl(job, company),
      location: job.location,
      salary_range: job.salaryRange,
      job_type: job.jobType,
      posted_at: postedAt,
      discovered_at: discoveredAt,
      match_score: job.score,
      match_details: buildMatchDetails(job, company, discoveredAt),
      is_new: job.postedDaysAgo <= 3,
      external_id: externalIdFor(job),
      job_function: job.jobFunction,
      seniority: job.seniority,
      language: 'en',
      country: job.country,
      is_remote: job.isRemote,
      source: company.source,
      quality_score: job.qualityScore,
      last_verified_at: hoursBefore(now, company.scrapedHoursAgo),
      still_open: true,
    }
  })

  // Step 4 item 3: autopilot's action-selection query (lib/graph/autopilot.ts
  // #loadCandidateJobs) allowlists on a verdict row, not just "not failing" —
  // a scored demo job with no eval_verdicts row would be silently starved
  // from autopilot the same way a real pre-verify-stage score would (see
  // 20260818000004_backfill_match_verdicts.sql's header for that side).
  // 'pass'/deterministic, never 'closed_qa': these scores were curated, not
  // produced by checkMatchVerdictDeterministic, so labelling them as a real
  // judge run would be a lie the migration's own comment already refuses to
  // tell for the same reason (see buildMatchDetails's 'demo/seed' provenance
  // note in lib/access/fixtures/jobs.ts).
  const evalVerdictRows = jobRows
    .filter((job) => job.match_score != null)
    .map((job) => ({
      id: id(`eval_verdict:match_score:${job.id}`),
      user_id: demoUserId,
      subject_kind: 'match_score',
      subject_id: job.id,
      judge: 'deterministic',
      verdict: 'pass',
      rationale: 'Seeded demo score — curated fixture, not model output.',
      created_at: job.discovered_at,
    }))

  // --- applications + activities -------------------------------------------
  const applicationIdByJobSlug = new Map<string, string>()
  const applicationRows: Record<string, unknown>[] = []
  const activityRows: Record<string, unknown>[] = []

  for (const app of DEMO_APPLICATIONS) {
    const job = jobBySlug(app.jobSlug)
    const rowId = id(`application:${app.jobSlug}`)
    applicationIdByJobSlug.set(app.jobSlug, rowId)

    // Sanity rail on the fixture itself: applying before the posting existed
    // would be visible nonsense on the timeline, and it is the kind of thing an
    // edit to one number silently introduces.
    if (app.appliedDaysAgo != null && app.appliedDaysAgo > job.postedDaysAgo) {
      throw new Error(
        `Demo fixture is inconsistent: application to "${app.jobSlug}" predates the posting.`
      )
    }

    const createdDaysAgo = app.appliedDaysAgo ?? app.updatedDaysAgo
    applicationRows.push({
      id: rowId,
      user_id: demoUserId,
      job_id: jobIdBySlug.get(app.jobSlug)!,
      stage: app.stage,
      applied_at: app.appliedDaysAgo == null ? null : daysBefore(now, app.appliedDaysAgo),
      source: app.source,
      notes: app.notes,
      resume_version: null,
      cover_letter: null,
      created_at: daysBefore(now, createdDaysAgo),
      updated_at: daysBefore(now, app.updatedDaysAgo),
    })

    for (const [index, activity] of app.activities.entries()) {
      activityRows.push({
        id: id(`activity:${app.jobSlug}:${index}`),
        application_id: rowId,
        type: activity.type,
        title: activity.title,
        description: activity.description,
        metadata: { source: 'demo/seed' },
        occurred_at: daysBefore(now, activity.daysAgo),
        created_at: daysBefore(now, activity.daysAgo),
      })
    }
  }

  // --- contacts ------------------------------------------------------------
  const contactIdBySlug = new Map<string, string>()
  const contactRows = DEMO_CONTACTS.map((contact) => {
    const rowId = id(`contact:${contact.slug}`)
    contactIdBySlug.set(contact.slug, rowId)
    return {
      id: rowId,
      user_id: demoUserId,
      company_id: companyIdBySlug.get(contact.companySlug)!,
      name: contact.name,
      email: contact.email,
      linkedin_url: contact.profileUrl,
      title: contact.title,
      relationship: contact.relationship,
      last_contact_at:
        contact.lastContactDaysAgo == null ? null : daysBefore(now, contact.lastContactDaysAgo),
      notes: contact.notes,
      created_at: daysBefore(now, 22),
      source: contact.source,
      confidence: contact.confidence,
      // Never true. See fixtures/contacts.ts — nothing verified these addresses,
      // and a green "verified" badge on a fabricated address teaches the viewer
      // to trust a signal we did not earn.
      verified: false,
      basis: contact.basis,
    }
  })

  // --- follow-ups ----------------------------------------------------------
  const followUpRows = DEMO_FOLLOW_UPS.map((followUp) => ({
    id: id(`follow_up:${followUp.key}`),
    contact_id: followUp.contactSlug ? contactIdBySlug.get(followUp.contactSlug)! : null,
    application_id: followUp.applicationJobSlug
      ? applicationIdByJobSlug.get(followUp.applicationJobSlug)!
      : null,
    due_date: hoursFromNow(now, followUp.dueHoursFromNow),
    note: followUp.note,
    is_completed: followUp.isCompleted,
    completed_at:
      followUp.isCompleted && followUp.completedHoursAgo != null
        ? hoursBefore(now, followUp.completedHoursAgo)
        : null,
    created_at: daysBefore(now, 14),
  }))

  // --- the finished agent run ----------------------------------------------
  const runId = id(`agent_run:${DEMO_AGENT_RUN.key}`)
  const runStartedAt = hoursBefore(now, DEMO_AGENT_RUN.startedHoursAgo)
  const runStartedMs = Date.parse(runStartedAt)

  const agentRunRows = [
    {
      id: runId,
      user_id: demoUserId,
      goal: DEMO_AGENT_RUN.goal,
      status: DEMO_AGENT_RUN.status,
      plan: { steps: DEMO_AGENT_RUN.steps.map((step) => ({ agent: step.agentType, label: step.label })) },
      budget_tokens: DEMO_AGENT_RUN.budgetTokens,
      spent_tokens: DEMO_AGENT_RUN.spentTokens,
      result: DEMO_AGENT_RUN.result,
      error: null,
      started_at: runStartedAt,
      finished_at: new Date(runStartedMs + DEMO_AGENT_RUN.durationMinutes * 60_000).toISOString(),
      created_at: runStartedAt,
    },
  ]

  // trace_spans-shaped, not agent_steps (binding ruling 1's endgame — see
  // lib/graph/journal.ts's header). kind='node' + attributes.stepStatus is
  // exactly what journalStepStart/Finish would have written for a real run
  // (isJournaledStepRow there is what the read side keys off); every
  // DEMO_AGENT_RUN step is 'completed', so the coarse `status` column
  // projects to 'ok' uniformly (see journal.ts#projectSpanStatus).
  const agentStepRows = DEMO_AGENT_RUN.steps.map((step, index) => {
    const stepStartedMs = runStartedMs + step.startedMinute * 60_000
    const startTime = new Date(stepStartedMs).toISOString()
    return {
      span_id: id(`agent_step:${DEMO_AGENT_RUN.key}:${index}`),
      trace_id: runId,
      parent_span_id: null,
      user_id: demoUserId,
      thread_id: null,
      run_id: runId,
      name: step.label,
      kind: 'node',
      start_time: startTime,
      end_time: new Date(stepStartedMs + step.durationSeconds * 1000).toISOString(),
      status: 'ok',
      attributes: {
        agentType: step.agentType,
        stepStatus: step.status,
        iteration: null,
        input: {},
        output: step.output,
        tokensUsed: step.tokensUsed,
      },
      events: null,
    }
  })

  // --- the approval queue --------------------------------------------------
  const draftRows = DEMO_DRAFTS.map((draft) => ({
    id: id(`draft:${draft.jobSlug}`),
    user_id: demoUserId,
    job_id: jobIdBySlug.get(draft.jobSlug)!,
    run_id: runId,
    resume_summary: draft.resumeSummary,
    cover_letter: draft.coverLetter,
    answers: draft.answers,
    status: draft.status,
    submitted_at: null,
    submission_ref: null,
    created_at: daysBefore(now, draft.createdDaysAgo),
    updated_at: daysBefore(now, draft.createdDaysAgo),
  }))

  const outreachRows = DEMO_OUTREACH.map((message) => {
    const contact = contactBySlug(message.contactSlug)
    if (!contact.email) {
      // outreach_messages.to_email is NOT NULL; a fixture edit that removed an
      // address should fail here, loudly, rather than at the database.
      throw new Error(
        `Demo fixture is inconsistent: outreach "${message.key}" targets ${contact.slug}, who has no email.`
      )
    }
    const timestamp = daysBefore(now, message.createdDaysAgo)
    return {
      id: id(`outreach:${message.key}`),
      user_id: demoUserId,
      contact_id: contactIdBySlug.get(message.contactSlug)!,
      job_id: jobIdBySlug.get(message.jobSlug)!,
      company_id: companyIdBySlug.get(contact.companySlug)!,
      run_id: null,
      to_email: contact.email,
      to_name: contact.name,
      subject: message.subject,
      body: message.body,
      status: message.status,
      kind: 'initial',
      parent_id: null,
      gmail_message_id: null,
      gmail_thread_id: null,
      error: null,
      sent_at: message.status === 'sent' ? timestamp : null,
      created_at: timestamp,
      updated_at: timestamp,
    }
  })

  // --- the base resume -----------------------------------------------------
  // markdown AND plain text written together, through the same two helpers the
  // resume studio uses. lib/resume/types.ts is emphatic that authoring one
  // without the other makes the exported PDF and the text an ATS reads describe
  // different resumes; this is the one place a seeder could quietly do that.
  const resumeRows = [
    {
      id: id('resume_document:base:v1'),
      user_id: demoUserId,
      job_id: null,
      draft_id: null,
      version: 1,
      title: `${DEMO_PERSONA.fullName} — base resume`,
      content: markdownToPlainText(DEMO_RESUME_MARKDOWN),
      content_json: toResumeContentJson(DEMO_RESUME_MARKDOWN, DEFAULT_TEMPLATE_ID),
      ats_score: 82,
      source: 'base',
      created_at: daysBefore(now, 24),
      updated_at: daysBefore(now, 24),
    },
  ]

  // --- prep artefacts ------------------------------------------------------
  const interviewKitRows = DEMO_INTERVIEW_KITS.map((kit) => {
    const job = jobBySlug(kit.jobSlug)
    return {
      id: id(`interview_kit:${kit.jobSlug}`),
      user_id: demoUserId,
      job_id: jobIdBySlug.get(kit.jobSlug)!,
      company_id: companyIdBySlug.get(job.companySlug)!,
      questions: kit.questions,
      prep_notes: kit.prepNotes,
      star_stories: kit.starStories,
      status: 'ready',
      created_at: daysBefore(now, 3),
      updated_at: daysBefore(now, 3),
    }
  })

  const dossierRows = DEMO_DOSSIERS.map((dossier) => ({
    id: id(`company_dossier:${dossier.companySlug}`),
    company_id: companyIdBySlug.get(dossier.companySlug)!,
    user_id: demoUserId,
    summary: dossier.summary,
    signals: dossier.signals,
    comp_intel: dossier.compIntel,
    sponsors_visa: dossier.sponsorsVisa,
    sources: dossier.sources,
    refreshed_at: daysBefore(now, dossier.refreshedDaysAgo),
    created_at: daysBefore(now, dossier.refreshedDaysAgo),
  }))

  return {
    profile: {
      full_name: DEMO_PERSONA.fullName,
      resume_text: markdownToPlainText(DEMO_RESUME_MARKDOWN),
      is_demo: true,
    },
    fallbackEmail: DEMO_PERSONA.email,
    // ORDER IS FOREIGN-KEY ORDER. companies before jobs, jobs before
    // applications, applications before activities, the run before its steps
    // and the drafts that point at it.
    batches: [
      { table: 'companies', rows: companyRows, required: true },
      { table: 'jobs', rows: jobRows, required: true },
      { table: 'eval_verdicts', rows: evalVerdictRows, required: false },
      { table: 'applications', rows: applicationRows, required: true },
      { table: 'activities', rows: activityRows, required: false },
      { table: 'contacts', rows: contactRows, required: false },
      { table: 'follow_ups', rows: followUpRows, required: false },
      { table: 'agent_runs', rows: agentRunRows, required: false },
      { table: 'trace_spans', rows: agentStepRows, required: false, conflictColumn: 'span_id' },
      { table: 'application_drafts', rows: draftRows, required: false },
      { table: 'outreach_messages', rows: outreachRows, required: false },
      { table: 'resume_documents', rows: resumeRows, required: false },
      { table: 'interview_kits', rows: interviewKitRows, required: false },
      { table: 'company_dossiers', rows: dossierRows, required: false },
    ],
  }
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

export interface SeedDemoOptions {
  /** Anchors every relative timestamp. Injected so the fixture is testable. */
  now?: Date
}

export interface SeedDemoResult {
  demoUserId: string
  /** Rows submitted per table. Unchanged between the first and second run. */
  counts: Record<string, number>
  /** Non-fatal table failures, so the caller can log an incomplete demo. */
  warnings: string[]
}

/** Row shape read by the safety gate below. */
interface ProfileGateRow {
  id: string
  email: string | null
  resume_text: string | null
  preferences: Record<string, unknown> | null
  is_demo: boolean | null
}

/**
 * Fill `demoUserId`'s workspace. Safe to call repeatedly.
 *
 * `admin` MUST be the service-role client (lib/harness/supabase-admin.ts
 * createAdminClient()). Several of these tables have no user-facing INSERT
 * policy at all — jobs, trace_spans — so an RLS-scoped client would silently
 * write half a demo.
 *
 * THE SAFETY GATE IS THE MOST IMPORTANT CODE IN THIS FILE. This function
 * overwrites a profile's name and resume, forces its spend cap to $1, and dumps
 * forty fabricated postings into its workspace. Pointed at a real account —
 * one transposed id, one bad call site — it would destroy a real person's job
 * search. So it refuses to touch anything that does not already look like a
 * demo account: either `is_demo` is already true, or the profile is
 * demonstrably untouched (no resume text and no companies of its own).
 */
export async function seedDemoWorkspace(
  admin: SupabaseClient,
  demoUserId: string,
  options: SeedDemoOptions = {}
): Promise<SeedDemoResult> {
  if (!demoUserId) throw new Error('seedDemoWorkspace: demoUserId is required')
  const now = options.now ?? new Date()

  // --- safety gate ---------------------------------------------------------
  const { data: profileData, error: profileError } = await admin
    .from('profiles')
    .select('id, email, resume_text, preferences, is_demo')
    .eq('id', demoUserId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`seedDemoWorkspace: could not read the demo profile — ${profileError.message}`)
  }
  const profile = profileData as ProfileGateRow | null
  if (!profile) {
    throw new Error(
      `seedDemoWorkspace: no profiles row for ${demoUserId}. The auth user must exist first.`
    )
  }

  if (profile.is_demo !== true) {
    const hasResume = typeof profile.resume_text === 'string' && profile.resume_text.trim().length > 0
    const { count, error: countError } = await admin
      .from('companies')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', demoUserId)

    // FAILS CLOSED. If we cannot prove the account is empty, we do not write to
    // it — the same posture lib/access/codes.ts takes on an unreadable expiry.
    if (countError) {
      throw new NotADemoProfileError(
        `seedDemoWorkspace: refusing to seed ${demoUserId} — could not confirm the account is empty (${countError.message}).`
      )
    }
    if (hasResume || (count ?? 0) > 0) {
      throw new NotADemoProfileError(
        `seedDemoWorkspace: refusing to seed ${demoUserId} — this profile already has real data and is not flagged is_demo.`
      )
    }
  }

  const workspace = buildDemoWorkspace(demoUserId, now)

  // --- the profile goes FIRST ----------------------------------------------
  // Deliberate ordering: `is_demo` and the $1 cap are the guardrails. Writing
  // them before the content means a seeder that dies half way still leaves a
  // flagged, capped demo account rather than an uncapped one holding a
  // fabricated job search.
  const profilePatch: Record<string, unknown> = {
    ...workspace.profile,
    preferences: buildDemoPreferences(profile.preferences, now),
  }
  // The auth trigger copies auth.users.email into profiles.email, and that is
  // the account's real login. Only fill it in if it is somehow missing —
  // overwriting it would make the profile disagree with the auth user.
  if (!profile.email || !profile.email.trim()) {
    profilePatch.email = workspace.fallbackEmail
  }

  const { error: patchError } = await admin.from('profiles').update(profilePatch).eq('id', demoUserId)
  if (patchError) {
    throw new Error(`seedDemoWorkspace: could not write the demo profile — ${patchError.message}`)
  }

  // --- content -------------------------------------------------------------
  const counts: Record<string, number> = {}
  const warnings: string[] = []

  for (const batch of workspace.batches) {
    counts[batch.table] = batch.rows.length
    if (batch.rows.length === 0) continue

    // ignoreDuplicates, NOT a full upsert: on a second run every id already
    // exists, and overwriting would undo whatever the demo user did in their
    // session — cards they dragged across the kanban, drafts they approved.
    // "Seed what is missing" is the correct idempotent behaviour here.
    const { error } = await admin
      .from(batch.table)
      .upsert(batch.rows, { onConflict: batch.conflictColumn ?? 'id', ignoreDuplicates: true })

    if (!error) continue

    const message = `${batch.table}: ${error.message}`
    if (batch.required) {
      throw new Error(`seedDemoWorkspace: could not seed a required table — ${message}`)
    }
    // Optional tables degrade to an empty state on one page rather than
    // failing the whole redemption. Never swallowed silently.
    console.error('[seed-demo] optional table failed to seed —', message)
    warnings.push(message)
  }

  return { demoUserId, counts, warnings }
}
