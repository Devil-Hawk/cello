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
 * The demo profile's base resume, in the AUTHORED Markdown shape the resume
 * tooling expects (lib/resume/types.ts: `content_json.markdown` is authored,
 * `content` is derived from it via markdownToPlainText — the seeder does both
 * together through the same helpers the studio uses, never one without the
 * other).
 *
 * Headings, bullet lists and inline bold only: that is exactly the grammar
 * lib/resume/markdown.ts parses and every template renders, so this document
 * exports cleanly to PDF/DOCX without the demo hitting an unsupported
 * construct.
 */
export const DEMO_RESUME_MARKDOWN = `# Riley Marsh

Senior Backend / Platform Engineer — Seattle, WA (open to remote, US)

riley.marsh@demo.example.com | (206) 555-0142 | riley-marsh.example.com

## Summary

Backend and platform engineer with eight years building high-throughput data
services. Most recently led the ingestion and query tier for a multi-tenant
analytics product serving 4B events/day, cutting p99 read latency from 1.9s to
310ms while halving infrastructure spend. Comfortable owning a system end to
end: schema design, service code, rollout, on-call, and the cost line.

## Experience

### Staff Software Engineer — Cobalt Harbor Systems

*Seattle, WA — Mar 2022 to present*

- Rebuilt the event ingestion pipeline (Kafka to a columnar store) behind a
  dual-write migration, moving 4B events/day with **zero customer-visible
  downtime** and no backfill gaps.
- Designed the sharded query planner that took p99 dashboard reads from 1.9s to
  310ms; published the load-shedding policy the whole platform group adopted.
- Cut compute spend 48% by right-sizing the streaming tier and introducing
  tiered storage for cold partitions — roughly $1.1M/year.
- Ran the on-call rotation for six services and drove incident review; MTTR fell
  from 74 to 22 minutes over four quarters.
- Mentored four engineers, two of whom were promoted to senior.

### Senior Software Engineer — Trellis Point Analytics

*Remote — Jun 2019 to Feb 2022*

- Owned the metrics API used by every customer-facing dashboard: Go services on
  Kubernetes, Postgres and ClickHouse behind them, 12k RPS at peak.
- Introduced contract tests and a staged rollout pipeline that took change
  failure rate from 18% to under 4%.
- Led the SOC 2 workstream for the data plane: audit logging, key rotation, and
  tenant isolation review across nine services.
- Built the internal query-cost attribution tool that made per-tenant unit
  economics visible to product for the first time.

### Software Engineer — Halden & Reeve

*Portland, OR — Aug 2017 to May 2019*

- Shipped the billing reconciliation service that closed a recurring six-figure
  revenue leak from unmatched invoice lines.
- Migrated a monolithic Rails scheduler to a queue-backed Python worker fleet,
  cutting nightly batch runtime from 6h to 40m.
- First engineer on the internal API gateway; wrote the auth middleware still in
  use today.

## Skills

- **Languages:** Go, Python, TypeScript, SQL, some Rust
- **Data:** Postgres, ClickHouse, Kafka, Spark, dbt, Iceberg
- **Platform:** Kubernetes, Terraform, AWS (EKS, S3, RDS, MSK), GitHub Actions
- **Practice:** distributed systems design, performance and cost work, incident
  command, technical mentoring

## Education

### B.S. Computer Science — Cascade Ridge University

*Portland, OR — 2013 to 2017*

- Senior project: a fault-injection harness for stream processors.

## Selected Projects

- **Tidewater** — an open-source CLI that diffs two Postgres query plans and
  explains the regression in plain language. 2.1k stars.
- **Slate** — a tiny Go library for typed feature flags with compile-time
  exhaustiveness checks, used in production at two former employers.
`

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
    minScore: 50,
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
