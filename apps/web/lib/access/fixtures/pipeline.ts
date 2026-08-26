// Everything downstream of a job: the pipeline, its timeline, the approval
// queue, outreach, follow-ups, one finished agent run, and the prep artefacts.
//
// WHY ALL OF THIS AND NOT JUST APPLICATIONS
//   The brief is that a demo must not hit an empty state. Tracing what the four
//   headline pages actually read:
//     /dashboard  companies, jobs, applications, follow_ups, agent_runs (via
//                 /api/harness/run), profiles.preferences.budget
//     /pipeline   applications joined to jobs
//     /queue      application_drafts (/api/drafts) and outreach_messages
//                 (/api/outreach)
//     /insights   applications+jobs, activities, outreach_messages, follow_ups,
//                 and the job-corpus charts off /api/jobs/insights-summary
//   Miss any one of those tables and a whole surface of the product renders its
//   "nothing here yet" card during the demo.
//
// TIMELINES ARE CAUSALLY ORDERED
//   Every `daysAgo` below is smaller than the `postedDaysAgo` of the job it
//   refers to, and every activity falls between the application date and now.
//   A demo where someone applied to a job three days before it was posted is a
//   demo where the viewer stops trusting the data.

import type { InterviewQuestion, StarStory } from '@/lib/interview/store'
import type { CompIntel, DossierSignals, SourceRef } from '@/lib/dossier/store'

// ---------------------------------------------------------------------------
// Applications + their activity timelines
// ---------------------------------------------------------------------------

export interface DemoActivity {
  /**
   * Free text, but the words matter: components/insights/compute.ts treats an
   * activity whose type matches /screen|interview|reply|response|recruiter|
   * call|phone/ as "the employer responded", and that is what makes
   * "median time to reply" computable rather than "—".
   */
  type: string
  title: string
  description: string
  daysAgo: number
}

export interface DemoApplication {
  jobSlug: string
  /** lib/format.ts PipelineStage. All seven appear across this list. */
  stage: string
  /** null for stage 'discovered' — nothing has been sent yet. */
  appliedDaysAgo: number | null
  /** Days before now the row last moved; drives "avg time in stage" on /insights. */
  updatedDaysAgo: number
  /** Matches the vocabulary already written by the product itself. */
  source: string
  notes: string
  activities: readonly DemoActivity[]
}

export const DEMO_APPLICATIONS: readonly DemoApplication[] = [
  {
    jobSlug: 'vantage-payments',
    stage: 'offer',
    appliedDaysAgo: 18,
    updatedDaysAgo: 3,
    source: 'referral',
    notes: 'Verbal offer at the top of band. Decision due end of week.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Applied through the Vantage Loom careers page.', daysAgo: 18 },
      { type: 'recruiter_screen', title: 'Recruiter screen', description: '30 minutes with the payments recruiting partner. Comp band confirmed.', daysAgo: 14 },
      { type: 'interview_loop', title: 'Onsite loop', description: 'Four rounds: systems design, ledger deep-dive, coding, values.', daysAgo: 9 },
      { type: 'offer_received', title: 'Offer received', description: 'Verbal offer at $228k base plus equity. Written offer to follow.', daysAgo: 3 },
    ],
  },
  {
    jobSlug: 'larkspur-platform',
    stage: 'ghosted',
    appliedDaysAgo: 14,
    updatedDaysAgo: 14,
    source: 'cello-autopilot',
    notes: 'No acknowledgement after two weeks. Jonah offered to nudge internally.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Submitted via the Larkspur Robotics board.', daysAgo: 14 },
    ],
  },
  {
    jobSlug: 'orchid-ledger-core',
    stage: 'interview',
    appliedDaysAgo: 12,
    updatedDaysAgo: 4,
    source: 'referral',
    notes: 'Panel is Thursday. Asked to prepare a ledger consistency walkthrough.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Referred in by a former colleague on the ledger team.', daysAgo: 12 },
      { type: 'phone_screen', title: 'Phone screen', description: 'Recruiter call covering scope, timeline and comp expectations.', daysAgo: 8 },
      { type: 'interview_scheduled', title: 'Panel scheduled', description: 'Three-round panel booked for Thursday afternoon.', daysAgo: 4 },
    ],
  },
  {
    jobSlug: 'quillon-cloud-security',
    stage: 'rejected',
    appliedDaysAgo: 13,
    updatedDaysAgo: 6,
    source: 'harness/matcher',
    notes: 'Passed — they wanted a detection-engineering background specifically.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Auto-triaged into the pipeline at 58% match.', daysAgo: 13 },
      { type: 'email_reply', title: 'Reply from recruiting', description: 'Acknowledged the application and asked two screening questions.', daysAgo: 10 },
      { type: 'rejected', title: 'Rejected', description: 'Looking for hands-on detection engineering experience.', daysAgo: 6 },
    ],
  },
  {
    jobSlug: 'halcyon-routing',
    stage: 'screen',
    appliedDaysAgo: 9,
    updatedDaysAgo: 5,
    source: 'cello-autopilot',
    notes: 'Recruiter wants availability for a 45-minute technical screen.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Submitted with the routing-tailored resume version.', daysAgo: 9 },
      { type: 'recruiter_call', title: 'Recruiter call', description: 'Confirmed hybrid expectations (3 days in Denver) and salary band.', daysAgo: 5 },
    ],
  },
  {
    jobSlug: 'ironvale-grid-analytics',
    stage: 'screen',
    appliedDaysAgo: 12,
    updatedDaysAgo: 7,
    source: 'harness/matcher',
    notes: 'Hiring manager screen booked. They lead with time-series scale questions.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Auto-triaged into the pipeline at 67% match.', daysAgo: 12 },
      { type: 'recruiter_screen', title: 'Recruiter screen', description: 'Covered the grid analytics roadmap and the on-call rotation.', daysAgo: 7 },
    ],
  },
  {
    jobSlug: 'northwind-data-platform',
    stage: 'applied',
    appliedDaysAgo: 1,
    updatedDaysAgo: 1,
    source: 'manual',
    notes: 'Dana flagged this internally before it went live. Strongest fit on the board.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Applied with the tailored Data Platform resume version.', daysAgo: 1 },
    ],
  },
  {
    jobSlug: 'quillon-detection',
    stage: 'applied',
    appliedDaysAgo: 5,
    updatedDaysAgo: 5,
    source: 'cello-autopilot',
    notes: 'Approved from the queue. Cover letter leaned on the streaming rule work.',
    activities: [
      { type: 'applied', title: 'Application submitted', description: 'Approved in the review queue and submitted automatically.', daysAgo: 5 },
    ],
  },
  {
    jobSlug: 'tessellate-control-plane',
    stage: 'discovered',
    appliedDaysAgo: null,
    updatedDaysAgo: 3,
    source: 'harness/matcher',
    notes: 'Auto-triaged: match 87% (>= 75%).',
    activities: [],
  },
  {
    jobSlug: 'petrichor-inference',
    stage: 'discovered',
    appliedDaysAgo: null,
    updatedDaysAgo: 1,
    source: 'manual',
    notes: 'Top of the list. Wants a tailored resume before applying.',
    activities: [],
  },
]

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export interface DemoFollowUp {
  key: string
  /** Exactly one of these two is set — the table's CHECK requires a target. */
  contactSlug?: string
  applicationJobSlug?: string
  /** Negative = already overdue. Hours, so "due today" is unambiguous. */
  dueHoursFromNow: number
  note: string
  isCompleted: boolean
  /** Only meaningful when isCompleted. */
  completedHoursAgo?: number
}

export const DEMO_FOLLOW_UPS: readonly DemoFollowUp[] = [
  {
    key: 'ping-dana',
    contactSlug: 'dana-whitfield',
    dueHoursFromNow: -72,
    note: 'Ping Dana about the Data Platform referral — she offered to hand it to the hiring manager.',
    isCompleted: false,
  },
  {
    key: 'orchid-panel-prep',
    applicationJobSlug: 'orchid-ledger-core',
    dueHoursFromNow: -20,
    note: 'Send the ledger consistency walkthrough to the Orchid Ledger panel before Thursday.',
    isCompleted: false,
  },
  {
    key: 'marcus-availability',
    contactSlug: 'marcus-oyelaran',
    dueHoursFromNow: 18,
    note: 'Reply to Marcus with interview availability for the Inference role.',
    isCompleted: false,
  },
  {
    key: 'vantage-offer-decision',
    applicationJobSlug: 'vantage-payments',
    dueHoursFromNow: 96,
    note: 'Respond to the Vantage Loom offer by Friday.',
    isCompleted: false,
  },
  {
    key: 'aisha-reconnect',
    contactSlug: 'aisha-rahman',
    dueHoursFromNow: -240,
    note: 'Reconnect with Aisha now that a staff req has opened at Quillon.',
    isCompleted: true,
    completedHoursAgo: 216,
  },
]

// ---------------------------------------------------------------------------
// The approval queue: application drafts
// ---------------------------------------------------------------------------

export interface DemoDraft {
  jobSlug: string
  status: string
  createdDaysAgo: number
  resumeSummary: string
  coverLetter: string
  answers: Record<string, string>
}

export const DEMO_DRAFTS: readonly DemoDraft[] = [
  {
    jobSlug: 'sable-marketplace',
    status: 'pending_review',
    createdDaysAgo: 2,
    resumeSummary:
      'Reordered to lead with the search/ranking and read-heavy caching work from Cobalt Harbor, ' +
      'and pulled the marketplace-adjacent inventory consistency bullet up into the summary.',
    coverLetter:
      "Hi Sable Market team,\n\n" +
      "I spent the last three years owning the read path for a multi-tenant analytics product — " +
      "search, ranking, and the caching layer that kept p99 under 310ms at 12k RPS. The Marketplace " +
      "role reads like the same problem with inventory consistency stakes attached, which is the part " +
      "I find most interesting.\n\n" +
      "At Cobalt Harbor I rebuilt the ingestion tier behind a dual-write migration with no customer-" +
      "visible downtime, and cut compute spend 48% along the way. I'd want to bring the same " +
      "measure-first habit to seller-facing latency.\n\n" +
      "Happy to walk through any of it.\n\nRiley Marsh",
    answers: {
      'Why are you interested in this role?':
        'The ranking and inventory-consistency problems map directly onto the read-path work I have owned for the last three years.',
      'Are you authorized to work in the US?': 'Yes',
      'Do you require visa sponsorship?': 'No',
      'Earliest start date': 'Four weeks from offer',
    },
  },
  {
    jobSlug: 'fernwood-patient-platform',
    status: 'pending_review',
    createdDaysAgo: 2,
    resumeSummary:
      'Emphasised the SOC 2 workstream, audit logging and tenant isolation review — the closest ' +
      'evidence on file for regulated-data work — and trimmed the robotics-adjacent bullets.',
    coverLetter:
      "Hi Fernwood Health team,\n\n" +
      "Regulated data changes how you design: audit trails stop being a nice-to-have and start being " +
      "the schema. I led the SOC 2 workstream for a nine-service data plane — audit logging, key " +
      "rotation, tenant isolation review — and I would bring that instinct to the Patient Platform.\n\n" +
      "I have not worked with HL7 or FHIR directly, so I would be learning that from scratch. " +
      "Everything else in the posting — event-driven service design, Postgres schema evolution — is " +
      "what I do day to day.\n\n" +
      "Riley Marsh",
    answers: {
      'Why are you interested in this role?':
        'Care coordination is a genuinely hard consistency problem, and the regulated-data constraints are ones I have worked inside before.',
      'Are you authorized to work in the US?': 'Yes',
      'Do you require visa sponsorship?': 'No',
      'Earliest start date': 'Four weeks from offer',
    },
  },
  {
    jobSlug: 'halcyon-carrier-api',
    status: 'approved',
    createdDaysAgo: 4,
    resumeSummary:
      'Led with the public API gateway and auth middleware work from Halden & Reeve, plus the ' +
      'partner-webhook reliability bullets.',
    coverLetter:
      "Hi Halcyon Freight team,\n\n" +
      "I was the first engineer on an internal API gateway that is still running today, and I have " +
      "spent most of my career on the versioning, rate-limiting and retry semantics that decide " +
      "whether a partner integration is pleasant or painful.\n\n" +
      "EDI is new to me. API design at scale is not.\n\nRiley Marsh",
    answers: {
      'Why are you interested in this role?':
        'Carrier integrations are a partner-API problem, and partner APIs are what I have spent the most time getting right.',
      'Are you authorized to work in the US?': 'Yes',
      'Do you require visa sponsorship?': 'No',
      'Earliest start date': 'Four weeks from offer',
    },
  },
]

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

export interface DemoOutreach {
  key: string
  contactSlug: string
  jobSlug: string
  status: string
  /** Days before now. For 'sent' rows this is also sent_at. */
  createdDaysAgo: number
  subject: string
  body: string
}

export const DEMO_OUTREACH: readonly DemoOutreach[] = [
  {
    key: 'dana-data-platform',
    contactSlug: 'dana-whitfield',
    jobSlug: 'northwind-data-platform',
    status: 'sent',
    createdDaysAgo: 1,
    subject: 'Data Platform role at Northwind Atlas',
    body:
      "Hi Dana,\n\n" +
      "Good to see the Data Platform opening go live — I applied this morning. Since we last worked " +
      "together I have been on the ingestion and query tier at Cobalt Harbor, most recently moving " +
      "4B events/day onto a columnar store with no customer-visible downtime.\n\n" +
      "If it is useful I can send the one-page write-up of that migration. And if you are still up " +
      "for passing the resume along, I would appreciate it.\n\n" +
      "Riley",
  },
  {
    key: 'aisha-cloud-security',
    contactSlug: 'aisha-rahman',
    jobSlug: 'quillon-cloud-security',
    status: 'sent',
    createdDaysAgo: 12,
    subject: 'Following up on the Cloud Security role',
    body:
      "Hi Aisha,\n\n" +
      "We spoke last year about a platform role at Quillon. I have just applied for the Cloud " +
      "Security opening — IAM policy design and workload identity are close to the tenant isolation " +
      "work I led through our SOC 2 review.\n\n" +
      "Worth a short call?\n\nRiley Marsh",
  },
  {
    key: 'wren-patient-platform',
    contactSlug: 'wren-castellanos',
    jobSlug: 'fernwood-patient-platform',
    status: 'pending_review',
    createdDaysAgo: 2,
    subject: 'Patient Platform opening at Fernwood',
    body:
      "Hi Wren,\n\n" +
      "You mentioned the Patient Platform team was hiring — the posting went up on Monday and it " +
      "lines up well with the event-driven and audit-logging work I have been doing.\n\n" +
      "Any sense of what they are optimising for in the loop? Happy to buy the coffee.\n\nRiley",
  },
  {
    key: 'jonah-fleet-platform',
    contactSlug: 'jonah-fielding',
    jobSlug: 'larkspur-platform',
    status: 'pending_review',
    createdDaysAgo: 3,
    subject: 'Senior Platform Engineer application at Larkspur',
    body:
      "Hi Jonah,\n\n" +
      "We connected after your talk on fleet telemetry last year. I applied for the Senior Platform " +
      "Engineer role a couple of weeks ago and have not heard anything — no expectation, but if you " +
      "can tell whether the req is still live I would be grateful.\n\n" +
      "Riley Marsh",
  },
]

// ---------------------------------------------------------------------------
// One finished agent run, so the harness surfaces are not empty
// ---------------------------------------------------------------------------

export interface DemoAgentStep {
  agentType: string
  label: string
  status: string
  /** Minutes into the run when this step started. */
  startedMinute: number
  durationSeconds: number
  tokensUsed: number
  output: Record<string, unknown>
}

export const DEMO_AGENT_RUN = {
  key: 'nightly-triage',
  goal: 'Find new roles matching my targeting, score them, and draft applications for the strongest fits',
  status: 'completed',
  startedHoursAgo: 26,
  durationMinutes: 4,
  budgetTokens: 200_000,
  spentTokens: 18_420,
  result: {
    jobsSourced: 40,
    jobsScored: 37,
    strongMatches: 5,
    draftsCreated: 3,
    summary:
      '37 of 40 postings scored. Five cleared 85%. Three application drafts are waiting in the review queue.',
  },
  steps: [
    {
      agentType: 'planner',
      label: 'Plan the run',
      status: 'completed',
      startedMinute: 0,
      durationSeconds: 12,
      tokensUsed: 1_240,
      output: { steps: ['sourcer', 'matcher', 'cv_tailor'], reasoning: 'Targeting is configured; go straight to sourcing.' },
    },
    {
      agentType: 'sourcer',
      label: 'Refresh 12 tracked company boards',
      status: 'completed',
      startedMinute: 0,
      durationSeconds: 96,
      tokensUsed: 0,
      output: { companiesRefreshed: 12, jobsDiscovered: 40, newSinceLastRun: 6 },
    },
    {
      agentType: 'matcher',
      label: 'Score 40 postings against the resume',
      status: 'completed',
      startedMinute: 2,
      durationSeconds: 78,
      tokensUsed: 14_180,
      output: { scored: 37, skipped: 3, strong: 5, good: 10, fair: 12, weak: 10 },
    },
    {
      agentType: 'cv_tailor',
      label: 'Draft applications for the strongest fits',
      status: 'completed',
      startedMinute: 3,
      durationSeconds: 44,
      tokensUsed: 3_000,
      output: { drafts: 3, queuedForReview: 2, autoApproved: 1 },
    },
  ] as readonly DemoAgentStep[],
} as const

// ---------------------------------------------------------------------------
// Interview prep kits
// ---------------------------------------------------------------------------

export interface DemoInterviewKit {
  jobSlug: string
  questions: readonly InterviewQuestion[]
  prepNotes: string
  starStories: readonly StarStory[]
}

export const DEMO_INTERVIEW_KITS: readonly DemoInterviewKit[] = [
  {
    jobSlug: 'orchid-ledger-core',
    prepNotes:
      'Panel is three rounds: ledger design, a Postgres performance discussion, and a values ' +
      'conversation. They will push hard on correctness under concurrency — have the dual-write ' +
      'migration story ready, including what you would do differently.',
    questions: [
      {
        category: 'technical',
        question: 'How would you guarantee that a double-entry ledger stays balanced under concurrent writes?',
        guidance:
          'Name the isolation level you would rely on and why. Talk about idempotency keys and the ' +
          'difference between preventing a bad write and detecting one after the fact.',
        sampleAnswer:
          'I would make the posting operation a single transaction at repeatable read or higher, keyed ' +
          'by an idempotency token so retries collapse. Then I would still run a continuous ' +
          'reconciliation job, because the invariant is too important to defend in only one place — ' +
          'that is the pattern I used for billing reconciliation at Halden & Reeve.',
      },
      {
        category: 'technical',
        question: 'Walk us through a Postgres performance problem you diagnosed end to end.',
        guidance: 'Pick one with numbers. Show the measurement before the fix, not just the fix.',
        sampleAnswer:
          'Dashboard p99 was 1.9s. Plans showed a sequential scan on a partition we thought was ' +
          'pruned. I fixed the predicate so pruning applied, added a covering index, and moved cold ' +
          'partitions to tiered storage. p99 landed at 310ms and compute spend dropped 48%.',
      },
      {
        category: 'behavioral',
        question: 'Tell us about a migration you ran that could not have downtime.',
        guidance: 'STAR. Be specific about the rollback plan — that is what they are testing.',
        sampleAnswer:
          'The ingestion rebuild at Cobalt Harbor: dual-write, shadow reads with a diff job, then a ' +
          'per-tenant cutover with a one-command rollback for two weeks after. Zero customer-visible ' +
          'downtime and no backfill gaps.',
      },
      {
        category: 'company-specific',
        question: 'What do you think is hard about close automation specifically?',
        guidance:
          'You have no accounting background — say so, and show you have thought about the domain ' +
          'anyway. Honesty here beats a confident guess.',
        sampleAnswer:
          'I have not modelled an accounting close before, so I would be learning the domain. What ' +
          'looks hard from the outside is that correctness is not eventually-consistent — a close is ' +
          'a hard deadline with a legally meaningful output.',
      },
      {
        category: 'reverse',
        question: 'What would you ask them?',
        guidance: 'Ask about the thing that would actually change your decision.',
        sampleAnswer:
          'How much of the ledger core is still being changed weekly versus stable? And who owns the ' +
          'reconciliation alerts today?',
      },
    ],
    starStories: [
      {
        situation: 'Ingestion tier at Cobalt Harbor could not keep up with 4B events/day and reads were degrading.',
        task: 'Move to a columnar store without customer-visible downtime or data loss.',
        action: 'Built a dual-write path, ran shadow reads with a continuous diff, cut over per tenant with a one-command rollback.',
        result: 'Zero downtime, no backfill gaps, and p99 dashboard reads fell from 1.9s to 310ms.',
        mapsToQuestion: 'Tell us about a migration you ran that could not have downtime.',
      },
      {
        situation: 'Billing reconciliation at Halden & Reeve was leaking six figures a year in unmatched invoice lines.',
        task: 'Find the leak and stop it without disrupting the nightly close.',
        action: 'Wrote a reconciliation service that matched lines on a composite key and quarantined mismatches for review.',
        result: 'Closed the recurring leak and gave finance an auditable exception queue for the first time.',
        mapsToQuestion: 'How would you guarantee that a double-entry ledger stays balanced under concurrent writes?',
      },
    ],
  },
  {
    jobSlug: 'vantage-payments',
    prepNotes:
      'Offer stage — this kit is for the final values conversation and the comp discussion. Have the ' +
      'competing-timeline framing ready and a number you will actually say out loud.',
    questions: [
      {
        category: 'behavioral',
        question: 'Tell us about a time you disagreed with a technical decision your team had already made.',
        guidance: 'Show the disagreement AND the commitment. They are checking for both halves.',
        sampleAnswer:
          'I argued against sharding the metrics API by tenant and lost. I wrote down my concern, ' +
          'committed to the decision, and built the load-shedding policy that made the chosen design ' +
          'survivable. Six months later we revisited it with data.',
      },
      {
        category: 'role-specific',
        question: 'How do you think about exactly-once semantics in a payments path?',
        guidance: 'Do not claim exactly-once. Talk about effectively-once via idempotency and dedupe.',
        sampleAnswer:
          'You do not get exactly-once delivery; you get effectively-once processing. Idempotency keys ' +
          'at the boundary, a dedupe table with a retention window, and reconciliation that assumes ' +
          'both will occasionally fail.',
      },
      {
        category: 'reverse',
        question: 'What would you ask before accepting?',
        guidance: 'The offer is the moment you have the most leverage and the least information.',
        sampleAnswer:
          'What does the on-call rotation actually look like in a bad week, and what is the refresh ' +
          'policy on equity after year one?',
      },
    ],
    starStories: [
      {
        situation: 'The metrics API sharding decision at Trellis Point went against my recommendation.',
        task: 'Keep the system reliable under a design I had argued against.',
        action: 'Documented the risk, then built contract tests and a staged rollout pipeline plus a load-shedding policy.',
        result: 'Change failure rate fell from 18% to under 4%, and the design was revisited later with real data.',
        mapsToQuestion: 'Tell us about a time you disagreed with a technical decision your team had already made.',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Company dossiers
// ---------------------------------------------------------------------------

export interface DemoDossier {
  companySlug: string
  summary: string
  signals: DossierSignals
  compIntel: CompIntel
  /** likely | unlikely | unknown — the migration's vocabulary. */
  sponsorsVisa: string
  sources: readonly SourceRef[]
  refreshedDaysAgo: number
}

export const DEMO_DOSSIERS: readonly DemoDossier[] = [
  {
    companySlug: 'northwind-atlas',
    refreshedDaysAgo: 2,
    summary:
      'Northwind Atlas sells a warehouse-native analytics platform to mid-market data teams. Series C ' +
      'in early 2025, roughly 380 people, headquartered in Seattle with a hybrid three-day expectation. ' +
      'Engineering is organised around Data Platform, Query Engine, Ingestion and Console.',
    signals: {
      funding: 'Series C, early 2025',
      headcountTrend: 'Grew ~28% year over year; engineering is the largest function.',
      culture: 'Writing-first. Design docs precede implementation and are reviewed in public channels.',
      techStack: ['Go', 'Rust', 'Kafka', 'Iceberg', 'Kubernetes', 'TypeScript'],
      whatTheyWant:
        'Engineers who can own a subsystem end to end and argue about tradeoffs in writing rather than in meetings.',
      uncertainty:
        'Nothing public describes the on-call load, and the posting does not say how large the Data Platform team is.',
      summarySource: 'ai',
      news: [],
    },
    compIntel: {
      rangeLow: 185_000,
      rangeHigh: 260_000,
      source: 'Posted salary ranges across four open engineering roles',
      confidence: 'high',
    },
    sponsorsVisa: 'unknown',
    sources: [
      { title: 'Northwind Atlas — Careers', url: 'https://northwind-atlas.example.com/careers', matchedBy: 'careers' },
      { title: 'Northwind Atlas — Engineering blog', url: 'https://northwind-atlas.example.com/blog', matchedBy: 'official-site' },
    ],
  },
  {
    companySlug: 'petrichor-labs',
    refreshedDaysAgo: 1,
    summary:
      'Petrichor Labs is an applied AI research lab that ships inference infrastructure alongside its ' +
      'research output. San Francisco, hybrid, deliberately small — under 120 people. Engineering and ' +
      'research sit in the same reporting line, which is unusual and shows up in how roles are scoped.',
    signals: {
      funding: 'Series B, late 2025',
      headcountTrend: 'Roughly doubled in eighteen months, concentrated in infrastructure.',
      culture: 'Research-adjacent engineering. Expect to be asked to justify latency work in terms of research throughput.',
      techStack: ['Python', 'Go', 'CUDA', 'Kubernetes', 'Ray'],
      whatTheyWant:
        'Infrastructure engineers who are comfortable being the only non-researcher in the room and can still set the agenda.',
      uncertainty:
        'The public material does not distinguish the Inference team from the Compute team, and the two postings overlap.',
      summarySource: 'ai',
      news: [],
    },
    compIntel: {
      rangeLow: 200_000,
      rangeHigh: 300_000,
      source: 'Posted salary ranges across three open engineering roles',
      confidence: 'medium',
    },
    sponsorsVisa: 'likely',
    sources: [
      { title: 'Petrichor Labs — Careers', url: 'https://petrichor-labs.example.com/careers', matchedBy: 'careers' },
      { title: 'Petrichor Labs — Research index', url: 'https://petrichor-labs.example.com/research', matchedBy: 'official-site' },
    ],
  },
]
