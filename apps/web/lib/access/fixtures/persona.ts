// The person the demo workspace belongs to.
//
// EVERYTHING HERE IS FICTIONAL, AND DELIBERATELY LOOKS IT.
//   A demo workspace is a real Supabase account with real features pointed at
//   it — outreach can be drafted, resumes can be exported, contacts can be
//   emailed. So the seeded identity must never be mistakable for a real person:
//   * every address is under `example.com`, which RFC 2606 reserves and which
//     nothing can register or receive mail at, so a demo user who hits "send"
//     cannot reach a human being;
//   * every phone number is in the 555-01xx range reserved for fiction;
//   * no linkedin.com URL is ever emitted — a plausible-looking
//     linkedin.com/in/<slug> would eventually resolve to a real stranger's
//     profile, which is precisely the thing a demo must not do.

import { ResumeSchema, type Resume } from '@/lib/resume/schema'

/** Identity written onto the demo profile and echoed in the seeded resume. */
export const DEMO_PERSONA = {
  fullName: 'Riley Marsh',
  /** Only used when the auth user somehow has no email — see seed-demo.ts. */
  email: 'riley.marsh@demo.example.com',
  headline: 'Senior Backend / Platform Engineer',
  location: 'Seattle, WA',
  phone: '(206) 555-0142',
  /** Two-letter code matching the persona's targeting. */
  country: 'US',
} as const

/**
 * The demo profile's base resume, as the structured Resume the resume tooling
 * stores (lib/resume/schema.ts). The seeder derives every stored column from
 * it with deriveResumeColumns, the same helper the writer uses, so the
 * Markdown, the plain text and the structure cannot disagree.
 *
 * Fictional throughout, and free of em dashes: separators are " | " and " - ".
 */
export const DEMO_RESUME: Resume = ResumeSchema.parse({
  basics: {
    name: DEMO_PERSONA.fullName,
    label: 'Senior Backend / Platform Engineer',
    email: 'riley.marsh@demo.example.com',
    phone: DEMO_PERSONA.phone,
    location: { city: 'Seattle', region: 'WA (open to remote, US)' },
    url: 'riley-marsh.example.com',
    summary:
      'Backend and platform engineer with eight years building high-throughput data services. Most recently led the ingestion and query tier for a multi-tenant analytics product serving 4B events/day, cutting p99 read latency from 1.9s to 310ms while halving infrastructure spend. Comfortable owning a system end to end: schema design, service code, rollout, on-call, and the cost line.',
  },
  work: [
    {
      name: 'Cobalt Harbor Systems',
      position: 'Staff Software Engineer',
      location: 'Seattle, WA',
      startDate: '2022-03',
      current: true,
      highlights: [
        'Rebuilt the event ingestion pipeline (Kafka to a columnar store) behind a dual-write migration, moving 4B events/day with zero customer-visible downtime and no backfill gaps.',
        'Designed the sharded query planner that took p99 dashboard reads from 1.9s to 310ms; published the load-shedding policy the whole platform group adopted.',
        'Cut compute spend 48% by right-sizing the streaming tier and introducing tiered storage for cold partitions, roughly $1.1M/year.',
        'Ran the on-call rotation for six services and drove incident review; MTTR fell from 74 to 22 minutes over four quarters.',
        'Mentored four engineers, two of whom were promoted to senior.',
      ],
    },
    {
      name: 'Trellis Point Analytics',
      position: 'Senior Software Engineer',
      location: 'Remote',
      startDate: '2019-06',
      endDate: '2022-02',
      highlights: [
        'Owned the metrics API used by every customer-facing dashboard: Go services on Kubernetes, Postgres and ClickHouse behind them, 12k RPS at peak.',
        'Introduced contract tests and a staged rollout pipeline that took change failure rate from 18% to under 4%.',
        'Led the SOC 2 workstream for the data plane: audit logging, key rotation, and tenant isolation review across nine services.',
        'Built the internal query-cost attribution tool that made per-tenant unit economics visible to product for the first time.',
      ],
    },
    {
      name: 'Halden & Reeve',
      position: 'Software Engineer',
      location: 'Portland, OR',
      startDate: '2017-08',
      endDate: '2019-05',
      highlights: [
        'Shipped the billing reconciliation service that closed a recurring six-figure revenue leak from unmatched invoice lines.',
        'Migrated a monolithic Rails scheduler to a queue-backed Python worker fleet, cutting nightly batch runtime from 6h to 40m.',
        'First engineer on the internal API gateway; wrote the auth middleware still in use today.',
      ],
    },
  ],
  projects: [
    {
      name: 'Tidewater',
      description:
        'An open-source CLI that diffs two Postgres query plans and explains the regression in plain language. 2.1k stars.',
    },
    {
      name: 'Slate',
      description:
        'A tiny Go library for typed feature flags with compile-time exhaustiveness checks, used in production at two former employers.',
    },
  ],
  skills: [
    { name: 'Languages', keywords: ['Go', 'Python', 'TypeScript', 'SQL', 'some Rust'] },
    { name: 'Data', keywords: ['Postgres', 'ClickHouse', 'Kafka', 'Spark', 'dbt', 'Iceberg'] },
    { name: 'Platform', keywords: ['Kubernetes', 'Terraform', 'AWS (EKS, S3, RDS, MSK)', 'GitHub Actions'] },
    {
      name: 'Practice',
      keywords: ['distributed systems design', 'performance and cost work', 'incident command', 'technical mentoring'],
    },
  ],
  education: [
    {
      institution: 'Cascade Ridge University',
      studyType: 'B.S.',
      area: 'Computer Science',
      location: 'Portland, OR',
      startDate: '2013',
      endDate: '2017',
      courses: ['Senior project: a fault-injection harness for stream processors.'],
    },
  ],
  meta: { cello: { templateId: 'modern', parsedFrom: 'demo' } },
})

/**
 * Non-budget profile preferences for the demo.
 *
 * The budget block is deliberately NOT here: seed-demo.ts writes it by
 * read-modify-write so a re-seed can never reset accumulated spend (see the
 * comment there). Targeting is filled in so /jobs, the matcher and the digest
 * all have a configured worldview rather than the "targeting not configured"
 * empty state, and it matches the persona's resume so the seeded match scores
 * read as plausible.
 */
export const DEMO_PREFERENCES = {
  targeting: {
    functions: ['engineering', 'data'],
    seniority: ['senior', 'staff', 'principal'],
    countries: ['US', 'CA'],
    remoteOnly: false,
    languages: ['en'],
    excludedCompanies: [],
    excludedKeywords: ['unpaid', 'commission only'],
  },
  outreach: {
    // Human-approve stays ON for a demo. A demo account that could auto-send is
    // a demo account that could email someone; the seeded addresses are
    // unroutable, but the safe default should not depend on that.
    autoSend: false,
    dailyCap: 5,
  },
  // Same reasoning as outreach.autoSend: nothing leaves the account unattended.
  autoSubmit: false,
} as const
