// Forty fictional postings across the twelve demo employers.
//
// WHAT THIS FIXTURE HAS TO SUPPORT
//   The demo is judged on the pages that read jobs, so the spread is chosen,
//   not arbitrary:
//     * The assessment spans every state a role can be in: wanted strongly,
//       somewhat and hardly (`want`), a chance of Strong, Possible or Stretch that
//       follows from the requirements the résumé does not evidence, and 3 roles
//       NOT ASSESSED YET. The unassessed rows are deliberate: the dashboard's "Not
//       assessed yet" tile is a real product surface, and a demo that shows zero
//       there hides it.
//     * The chance carries cited evidence in the exact shape lib/scoring writes
//       (buildDemoFit below), so the fit panel, the checklist and the resume-line
//       citations all render real content instead of degrading to "no details".
//     * `source` spans greenhouse/lever/ashby/workday/scraper so the insights
//       source-performance chart has a mix.
//     * posted_at spreads over the last three weeks so the "posted in 24h" tile,
//       the recency sort and the `is_new` badge all have something to show.
//
// EVERY DESCRIPTION SAYS IT IS DEMO DATA.
//   The trailer on buildJobDescription() is not decoration. These postings carry
//   salary bands and hiring criteria; left unlabelled and copied out of the
//   product they would read as a genuine job market. One line at the bottom of
//   each description makes that impossible to mistake, and costs the demo
//   nothing.

import { labelChance, resumeLines } from '@/lib/scoring/chance'
import type { Requirement } from '@/lib/scoring/posting-requirements'
import type { RequirementCheck } from '@/lib/scoring/types'
import { companyBySlug, type DemoCompany } from './companies'

export interface DemoJob {
  slug: string
  companySlug: string
  title: string
  /** Human location string, e.g. "Seattle, WA (Hybrid)". */
  location: string
  /** ISO 3166-1 alpha-2, matching the jobs.country classifier column. */
  country: string
  isRemote: boolean
  salaryRange: string
  jobType: string
  /** lib/jobs/classify.ts JobFunction slug. */
  jobFunction: string
  /** lib/jobs/classify.ts Seniority slug. */
  seniority: string
  /** Days before "now" the posting went up. Spread across the last 3 weeks. */
  postedDaysAgo: number
  /** How strongly the demo person wants this role, 0 to 1, or null for the deliberately unassessed rows. Authored, like the rest of the fixture. */
  want: number | null
  qualityScore: number
  team: string
  /** What the role is actually about — drives the description AND the match evidence. */
  focus: readonly [string, string, string]
  /** Skills the résumé does not evidence — drives the honest `gaps` list. */
  missing: readonly string[]
}

/** Rough years-of-experience a seniority band implies, for the requirements list. */
const YEARS_BY_SENIORITY: Record<string, number> = {
  intern: 0,
  junior: 1,
  mid: 3,
  senior: 5,
  staff: 8,
  principal: 10,
  manager: 6,
  director: 12,
  exec: 15,
  unknown: 3,
}

export const DEMO_JOBS: readonly DemoJob[] = [
  // --- Northwind Atlas -----------------------------------------------------
  {
    slug: 'northwind-data-platform',
    companySlug: 'northwind-atlas',
    title: 'Senior Backend Engineer, Data Platform',
    location: 'Seattle, WA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$185,000 - $225,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 2,
    want: 0.88,
    qualityScore: 93,
    team: 'Data Platform',
    focus: ['streaming ingestion at multi-billion-event scale', 'columnar storage layout', 'multi-tenant isolation'],
    missing: ['Iceberg table maintenance'],
  },
  {
    slug: 'northwind-query-engine',
    companySlug: 'northwind-atlas',
    title: 'Staff Software Engineer, Query Engine',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$215,000 - $260,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'staff',
    postedDaysAgo: 6,
    want: 0.91,
    qualityScore: 95,
    team: 'Query Engine',
    focus: ['distributed query planning', 'vectorised execution', 'p99 latency work'],
    missing: ['Rust'],
  },
  {
    slug: 'northwind-ingestion-em',
    companySlug: 'northwind-atlas',
    title: 'Engineering Manager, Ingestion',
    location: 'Seattle, WA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$210,000 - $250,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'manager',
    postedDaysAgo: 12,
    want: 0.61,
    qualityScore: 88,
    team: 'Ingestion',
    focus: ['team leadership for a 7-person group', 'ingestion reliability', 'roadmap ownership'],
    missing: ['direct people-management experience', 'hiring loop ownership'],
  },
  {
    slug: 'northwind-console-design',
    companySlug: 'northwind-atlas',
    title: 'Product Designer, Console',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$150,000 - $180,000',
    jobType: 'Full-time',
    jobFunction: 'design',
    seniority: 'senior',
    postedDaysAgo: 9,
    want: 0.34,
    qualityScore: 84,
    team: 'Console',
    focus: ['design systems', 'complex data visualisation', 'end-to-end product flows'],
    missing: ['Figma component authoring', 'design portfolio'],
  },

  // --- Larkspur Robotics ---------------------------------------------------
  {
    slug: 'larkspur-platform',
    companySlug: 'larkspur-robotics',
    title: 'Senior Platform Engineer',
    location: 'Boston, MA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$175,000 - $205,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 15,
    want: 0.79,
    qualityScore: 90,
    team: 'Fleet Platform',
    focus: ['Kubernetes fleet operations', 'telemetry pipelines', 'deployment automation'],
    missing: ['ROS 2'],
  },
  {
    slug: 'larkspur-robotics-cpp',
    companySlug: 'larkspur-robotics',
    title: 'Robotics Software Engineer (C++)',
    location: 'Boston, MA',
    country: 'US',
    isRemote: false,
    salaryRange: '$165,000 - $200,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'mid',
    postedDaysAgo: 18,
    want: 0.44,
    qualityScore: 86,
    team: 'Motion',
    focus: ['real-time motion planning', 'sensor fusion', 'embedded C++'],
    missing: ['C++17 in production', 'real-time control loops'],
  },
  {
    slug: 'larkspur-sre',
    companySlug: 'larkspur-robotics',
    title: 'Site Reliability Engineer',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$170,000 - $200,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 4,
    want: 0.74,
    qualityScore: 89,
    team: 'Reliability',
    focus: ['SLO design and error budgets', 'incident command', 'observability tooling'],
    missing: ['Prometheus rule authoring at scale'],
  },

  // --- Vantage Loom --------------------------------------------------------
  {
    slug: 'vantage-payments',
    companySlug: 'vantage-loom',
    title: 'Senior Backend Engineer, Payments',
    location: 'New York, NY (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$190,000 - $230,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 20,
    want: 0.86,
    qualityScore: 92,
    team: 'Payments Core',
    focus: ['idempotent ledger writes', 'high-throughput Go services', 'exactly-once reconciliation'],
    missing: ['card network settlement'],
  },
  {
    slug: 'vantage-risk-data',
    companySlug: 'vantage-loom',
    title: 'Data Engineer, Risk',
    location: 'New York, NY',
    country: 'US',
    isRemote: false,
    salaryRange: '$165,000 - $195,000',
    jobType: 'Full-time',
    jobFunction: 'data',
    seniority: 'mid',
    postedDaysAgo: 16,
    want: 0.68,
    qualityScore: 87,
    team: 'Risk',
    focus: ['feature pipelines for fraud models', 'dbt model design', 'data quality contracts'],
    missing: ['feature-store operations', 'model monitoring'],
  },
  {
    slug: 'vantage-tpm',
    companySlug: 'vantage-loom',
    title: 'Technical Program Manager',
    location: 'New York, NY (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$160,000 - $190,000',
    jobType: 'Full-time',
    jobFunction: 'operations',
    seniority: 'senior',
    postedDaysAgo: 11,
    want: 0.41,
    qualityScore: 82,
    team: 'Platform PMO',
    focus: ['cross-team programme delivery', 'dependency mapping', 'executive reporting'],
    missing: ['formal programme management', 'portfolio-level planning'],
  },

  // --- Fernwood Health -----------------------------------------------------
  {
    slug: 'fernwood-patient-platform',
    companySlug: 'fernwood-health',
    title: 'Senior Software Engineer, Patient Platform',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$170,000 - $200,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 3,
    want: 0.77,
    qualityScore: 91,
    team: 'Patient Platform',
    focus: ['event-driven service design', 'Postgres schema evolution', 'audit logging for regulated data'],
    missing: ['HL7 / FHIR'],
  },
  {
    slug: 'fernwood-integrations',
    companySlug: 'fernwood-health',
    title: 'Backend Engineer, Integrations',
    location: 'Chicago, IL (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$150,000 - $180,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'mid',
    postedDaysAgo: 13,
    want: 0.66,
    qualityScore: 85,
    team: 'Integrations',
    focus: ['third-party API integration', 'retry and backoff design', 'partner onboarding tooling'],
    missing: ['EHR vendor integrations'],
  },
  {
    slug: 'fernwood-clinical-analyst',
    companySlug: 'fernwood-health',
    title: 'Clinical Data Analyst',
    location: 'Chicago, IL',
    country: 'US',
    isRemote: false,
    salaryRange: '$105,000 - $130,000',
    jobType: 'Full-time',
    jobFunction: 'data',
    seniority: 'mid',
    postedDaysAgo: 19,
    want: 0.29,
    qualityScore: 79,
    team: 'Clinical Analytics',
    focus: ['clinical quality reporting', 'cohort analysis', 'stakeholder dashboards'],
    missing: ['clinical domain background', 'HEDIS measure reporting'],
  },

  // --- Quillon Systems -----------------------------------------------------
  {
    slug: 'quillon-detection',
    companySlug: 'quillon-systems',
    title: 'Staff Engineer, Detection Platform',
    location: 'Austin, TX (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$200,000 - $245,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'staff',
    postedDaysAgo: 8,
    want: 0.83,
    qualityScore: 92,
    team: 'Detection Platform',
    focus: ['streaming rule evaluation', 'low-latency event enrichment', 'platform API design'],
    missing: ['threat detection content authoring'],
  },
  {
    slug: 'quillon-cloud-security',
    companySlug: 'quillon-systems',
    title: 'Security Engineer, Cloud',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$175,000 - $210,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 14,
    want: 0.58,
    qualityScore: 88,
    team: 'Cloud Security',
    focus: ['IAM policy design', 'workload identity', 'secure-by-default infrastructure'],
    missing: ['offensive security background', 'detection engineering'],
  },
  {
    slug: 'quillon-sales-engineer',
    companySlug: 'quillon-systems',
    title: 'Sales Engineer',
    location: 'Austin, TX',
    country: 'US',
    isRemote: false,
    salaryRange: '$140,000 - $180,000 OTE',
    jobType: 'Full-time',
    jobFunction: 'sales',
    seniority: 'mid',
    postedDaysAgo: 17,
    want: 0.22,
    qualityScore: 74,
    team: 'Go To Market',
    focus: ['technical discovery calls', 'proof-of-concept delivery', 'competitive positioning'],
    missing: ['customer-facing sales experience', 'quota carrying'],
  },

  // --- Halcyon Freight -----------------------------------------------------
  {
    slug: 'halcyon-routing',
    companySlug: 'halcyon-freight',
    title: 'Senior Software Engineer, Routing',
    location: 'Denver, CO (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$165,000 - $195,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 10,
    want: 0.72,
    qualityScore: 87,
    team: 'Routing',
    focus: ['constraint solving at scale', 'batch and online scoring', 'service decomposition'],
    missing: ['OR-Tools / MIP solvers'],
  },
  {
    slug: 'halcyon-carrier-api',
    companySlug: 'halcyon-freight',
    title: 'Backend Engineer, Carrier API',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$150,000 - $180,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'mid',
    postedDaysAgo: 5,
    want: 0.69,
    qualityScore: 86,
    team: 'Carrier Platform',
    focus: ['public API design and versioning', 'rate limiting', 'partner webhooks'],
    missing: ['EDI 204/214 transactions'],
  },
  {
    slug: 'halcyon-ops-analyst',
    companySlug: 'halcyon-freight',
    title: 'Operations Analyst',
    location: 'Denver, CO',
    country: 'US',
    isRemote: false,
    salaryRange: '$85,000 - $105,000',
    jobType: 'Full-time',
    jobFunction: 'operations',
    seniority: 'junior',
    postedDaysAgo: 21,
    want: 0.26,
    qualityScore: 71,
    team: 'Network Operations',
    focus: ['load board monitoring', 'carrier performance reporting', 'exception handling'],
    missing: ['freight brokerage operations', 'carrier network management'],
  },

  // --- Petrichor Labs ------------------------------------------------------
  {
    slug: 'petrichor-inference',
    companySlug: 'petrichor-labs',
    title: 'Member of Technical Staff, Inference',
    location: 'San Francisco, CA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$230,000 - $300,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'staff',
    postedDaysAgo: 1,
    want: 0.90,
    qualityScore: 96,
    team: 'Inference',
    focus: ['serving-path latency optimisation', 'GPU utilisation and batching', 'high-throughput Go and Python services'],
    missing: ['CUDA kernel authoring'],
  },
  {
    slug: 'petrichor-eval',
    companySlug: 'petrichor-labs',
    title: 'Research Engineer, Evaluation',
    location: 'San Francisco, CA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$200,000 - $260,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 7,
    want: 0.64,
    qualityScore: 90,
    team: 'Evaluation',
    focus: ['evaluation harness design', 'statistical rigour in benchmarking', 'reproducible pipelines'],
    missing: ['ML research publication record', 'PyTorch internals'],
  },
  {
    slug: 'petrichor-training-clusters',
    companySlug: 'petrichor-labs',
    title: 'Infrastructure Engineer, Training Clusters',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$210,000 - $265,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 11,
    want: 0.81,
    qualityScore: 93,
    team: 'Compute',
    focus: ['multi-node scheduling', 'storage throughput tuning', 'cost attribution for shared compute'],
    missing: ['InfiniBand fabric tuning'],
  },

  // --- Sable Market --------------------------------------------------------
  {
    slug: 'sable-marketplace',
    companySlug: 'sable-market',
    title: 'Senior Backend Engineer, Marketplace',
    location: 'Los Angeles, CA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$170,000 - $205,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 6,
    want: 0.75,
    qualityScore: 88,
    team: 'Marketplace',
    focus: ['search and ranking services', 'inventory consistency', 'read-heavy caching'],
    missing: ['Elasticsearch relevance tuning'],
  },
  {
    slug: 'sable-seller-tools',
    companySlug: 'sable-market',
    title: 'Full Stack Engineer, Seller Tools',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$150,000 - $180,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'mid',
    postedDaysAgo: 12,
    want: 0.62,
    qualityScore: 84,
    team: 'Seller Experience',
    focus: ['TypeScript and React product work', 'API-backed workflows', 'incremental migration of legacy screens'],
    missing: ['sustained front-end ownership'],
  },
  {
    slug: 'sable-growth-marketing',
    companySlug: 'sable-market',
    title: 'Growth Marketing Manager',
    location: 'Los Angeles, CA',
    country: 'US',
    isRemote: false,
    salaryRange: '$130,000 - $160,000',
    jobType: 'Full-time',
    jobFunction: 'marketing',
    seniority: 'manager',
    postedDaysAgo: 18,
    want: null,
    qualityScore: 76,
    team: 'Growth',
    focus: ['lifecycle campaign design', 'paid acquisition analysis', 'experiment design'],
    missing: ['marketing attribution', 'paid channel management'],
  },

  // --- Tessellate Cloud ----------------------------------------------------
  {
    slug: 'tessellate-control-plane',
    companySlug: 'tessellate-cloud',
    title: 'Staff Engineer, Control Plane',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$205,000 - $255,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'staff',
    postedDaysAgo: 4,
    want: 0.87,
    qualityScore: 94,
    team: 'Control Plane',
    focus: ['reconciliation-loop design', 'multi-region control planes', 'API compatibility guarantees'],
    missing: ['Kubernetes operator authoring'],
  },
  {
    slug: 'tessellate-networking',
    companySlug: 'tessellate-cloud',
    title: 'Senior Software Engineer, Networking',
    location: 'Portland, OR (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$180,000 - $215,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 9,
    want: 0.71,
    qualityScore: 89,
    team: 'Edge Network',
    focus: ['request routing at the edge', 'connection pooling and backpressure', 'load-shedding policy'],
    missing: ['eBPF', 'BGP operations'],
  },
  {
    slug: 'tessellate-support',
    companySlug: 'tessellate-cloud',
    title: 'Support Engineer, Enterprise',
    location: 'Portland, OR',
    country: 'US',
    isRemote: false,
    salaryRange: '$110,000 - $135,000',
    jobType: 'Full-time',
    jobFunction: 'support',
    seniority: 'mid',
    postedDaysAgo: 15,
    want: 0.31,
    qualityScore: 77,
    team: 'Enterprise Support',
    focus: ['escalation triage', 'customer debugging sessions', 'runbook authoring'],
    missing: ['customer-facing support experience', 'ticket queue ownership'],
  },

  // --- Orchid Ledger -------------------------------------------------------
  {
    slug: 'orchid-ledger-core',
    companySlug: 'orchid-ledger',
    title: 'Senior Backend Engineer, Ledger Core',
    location: 'Toronto, ON, Canada (Hybrid)',
    country: 'CA',
    isRemote: false,
    salaryRange: 'CA$165,000 - CA$195,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 13,
    want: 0.70,
    qualityScore: 87,
    team: 'Ledger Core',
    focus: ['double-entry ledger correctness', 'transactional consistency', 'Postgres performance work'],
    missing: ['accounting domain modelling'],
  },
  {
    slug: 'orchid-devex',
    companySlug: 'orchid-ledger',
    title: 'Platform Engineer, Developer Experience',
    location: 'Remote (Canada)',
    country: 'CA',
    isRemote: true,
    salaryRange: 'CA$150,000 - CA$180,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 7,
    want: 0.65,
    qualityScore: 85,
    team: 'Developer Experience',
    focus: ['CI pipeline throughput', 'local development environments', 'internal tooling ergonomics'],
    missing: ['Bazel'],
  },
  {
    slug: 'orchid-implementation',
    companySlug: 'orchid-ledger',
    title: 'Implementation Consultant',
    location: 'Toronto, ON, Canada',
    country: 'CA',
    isRemote: false,
    salaryRange: 'CA$95,000 - CA$120,000',
    jobType: 'Full-time',
    jobFunction: 'operations',
    seniority: 'mid',
    postedDaysAgo: 20,
    want: 0.24,
    qualityScore: 72,
    team: 'Professional Services',
    focus: ['customer onboarding projects', 'data migration planning', 'stakeholder training'],
    missing: ['consulting delivery experience', 'accounting close processes'],
  },

  // --- Ironvale Energy -----------------------------------------------------
  {
    slug: 'ironvale-grid-analytics',
    companySlug: 'ironvale-energy',
    title: 'Senior Software Engineer, Grid Analytics',
    location: 'Pittsburgh, PA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$160,000 - $190,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 14,
    want: 0.67,
    qualityScore: 86,
    team: 'Grid Analytics',
    focus: ['time-series storage at scale', 'streaming aggregation', 'anomaly detection pipelines'],
    missing: ['SCADA / utility telemetry protocols'],
  },
  {
    slug: 'ironvale-data-platform',
    companySlug: 'ironvale-energy',
    title: 'Data Platform Engineer',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$165,000 - $195,000',
    jobType: 'Full-time',
    jobFunction: 'data',
    seniority: 'senior',
    postedDaysAgo: 2,
    want: 0.73,
    qualityScore: 88,
    team: 'Data Platform',
    focus: ['lakehouse table design', 'orchestration and backfills', 'data quality contracts'],
    missing: ['Airflow at scale'],
  },
  {
    slug: 'ironvale-field-ops',
    companySlug: 'ironvale-energy',
    title: 'Field Operations Manager',
    location: 'Pittsburgh, PA',
    country: 'US',
    isRemote: false,
    salaryRange: '$115,000 - $140,000',
    jobType: 'Full-time',
    jobFunction: 'operations',
    seniority: 'manager',
    postedDaysAgo: 19,
    want: 0.19,
    qualityScore: 68,
    team: 'Field Operations',
    focus: ['crew scheduling', 'site safety compliance', 'vendor management'],
    missing: ['field operations leadership', 'utility site work'],
  },

  // --- Bluestem Media ------------------------------------------------------
  {
    slug: 'bluestem-playback',
    companySlug: 'bluestem-media',
    title: 'Senior Backend Engineer, Playback Services',
    location: 'Atlanta, GA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$155,000 - $185,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 3,
    want: 0.63,
    qualityScore: 83,
    team: 'Playback',
    focus: ['CDN-fronted service design', 'session state at scale', 'graceful degradation'],
    missing: ['DRM / license servers'],
  },
  {
    slug: 'bluestem-content-pipeline',
    companySlug: 'bluestem-media',
    title: 'Software Engineer, Content Pipeline',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$140,000 - $170,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'mid',
    postedDaysAgo: 8,
    want: 0.57,
    qualityScore: 81,
    team: 'Content Pipeline',
    focus: ['workflow orchestration', 'large-object storage handling', 'idempotent job retries'],
    missing: ['media asset management systems'],
  },
  {
    slug: 'bluestem-encoding',
    companySlug: 'bluestem-media',
    title: 'Video Encoding Engineer',
    location: 'Atlanta, GA',
    country: 'US',
    isRemote: false,
    salaryRange: '$150,000 - $180,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'senior',
    postedDaysAgo: 16,
    want: 0.52,
    qualityScore: 80,
    team: 'Encoding',
    focus: ['transcode farm throughput', 'quality/bitrate tuning', 'batch job scheduling'],
    missing: ['FFmpeg internals', 'codec-level tuning'],
  },
  {
    slug: 'bluestem-discovery-pm',
    companySlug: 'bluestem-media',
    title: 'Product Manager, Discovery',
    location: 'Atlanta, GA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$150,000 - $185,000',
    jobType: 'Full-time',
    jobFunction: 'product',
    seniority: 'senior',
    postedDaysAgo: 10,
    want: null,
    qualityScore: 79,
    team: 'Discovery',
    focus: ['recommendation product strategy', 'experiment prioritisation', 'cross-functional delivery'],
    missing: ['product management track record'],
  },
  {
    slug: 'bluestem-qa-automation',
    companySlug: 'bluestem-media',
    title: 'QA Automation Engineer',
    location: 'Remote (US)',
    country: 'US',
    isRemote: true,
    salaryRange: '$120,000 - $145,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'mid',
    postedDaysAgo: 21,
    want: 0.47,
    qualityScore: 78,
    team: 'Quality',
    focus: ['end-to-end test automation', 'flake reduction', 'device-matrix coverage'],
    missing: ['Playwright device farms', 'dedicated QA experience'],
  },
  {
    slug: 'bluestem-streaming-em',
    companySlug: 'bluestem-media',
    title: 'Engineering Manager, Streaming Infrastructure',
    location: 'Atlanta, GA (Hybrid)',
    country: 'US',
    isRemote: false,
    salaryRange: '$190,000 - $225,000',
    jobType: 'Full-time',
    jobFunction: 'engineering',
    seniority: 'manager',
    postedDaysAgo: 5,
    want: null,
    qualityScore: 85,
    team: 'Streaming Infrastructure',
    focus: ['managing a 9-person infrastructure group', 'reliability roadmap', 'cost governance'],
    missing: ['direct people-management experience'],
  },
]

/** External id used for the (company_id, external_id) dedupe key and the job URL. */
export function externalIdFor(job: DemoJob): string {
  return `demo-${job.slug}`
}

/** Where the posting "lives". Unroutable — the host is under example.com. */
export function jobUrl(job: DemoJob, company: DemoCompany): string {
  return `https://${company.domain}/careers/${externalIdFor(job)}`
}

/**
 * A complete, realistic posting body.
 *
 * Composed rather than hand-written per row: the authored content is the job's
 * `focus`/`team`/`missing`, and the scaffolding around it is shared. That keeps
 * forty postings maintainable while still producing forty genuinely different
 * documents — and, because it is pure, byte-identical on every run.
 */
export function buildJobDescription(job: DemoJob, company: DemoCompany): string {
  const years = YEARS_BY_SENIORITY[job.seniority] ?? 3
  const [first, second, third] = job.focus

  const lines: string[] = [
    `${company.name} is hiring a ${job.title} to join the ${job.team} team.`,
    '',
    company.blurb,
    '',
    "What you'll do",
    `- Own ${first} end to end — design, implementation, rollout and on-call.`,
    `- Partner with product and adjacent engineering teams on ${second}.`,
    `- Raise the bar on ${third}, and leave the codebase better documented than you found it.`,
    `- Review designs and code across the ${job.team} team, and help set the technical direction.`,
    '',
    "What we're looking for",
    `- ${years}+ years of hands-on ${job.jobFunction} experience.`,
    `- Demonstrated depth in ${first} and ${second}.`,
    `- Familiarity with ${job.missing.join(' and ')} is a strong plus.`,
    '- Clear written communication — we default to writing things down.',
    '',
    'Details',
    `- ${job.jobType} · ${job.location}${job.isRemote ? ' · Remote-friendly' : ''}`,
    `- Compensation range: ${job.salaryRange}`,
    '',
    `Demo data — ${company.name} is a fictional employer created for a Cello product demo. ` +
      'This posting is not a real job and nobody is hiring for it.',
  ]

  return lines.join('\n')
}

const STOP = new Set(['with', 'from', 'that', 'this', 'into', 'across', 'work', 'design', 'scale', 'end', 'direct'])

/** Content words of a phrase, lowercase, long enough to mean something. */
function contentWords(phrase: string): string[] {
  return (phrase.toLowerCase().match(/[a-z0-9+#.]{4,}/g) ?? []).filter((w) => !STOP.has(w))
}

/** The résumé line that best shows a phrase, by shared content words. Null when no line shares one. */
function lineShowing(phrase: string, lines: readonly { n: number; text: string }[]): { n: number; text: string } | null {
  const words = contentWords(phrase)
  let best: { n: number; text: string } | null = null
  let bestHits = 0
  for (const l of lines) {
    if (l.text.startsWith('#')) continue
    const hay = l.text.toLowerCase()
    const hits = words.filter((w) => hay.includes(w)).length
    if (hits > bestHits) {
      best = l
      bestHits = hits
    }
  }
  return best
}

export interface DemoFit {
  assessed_at: string | null
  blocked_reasons: unknown[]
  want_p: number | null
  want_reason: string | null
  want_detail: Record<string, unknown> | null
  chance: 'strong' | 'possible' | 'stretch' | null
  chance_detail: Record<string, unknown> | null
}

/** One sentence in the person's terms for why they might want the role. Curated, not model output. */
function wantReasonFor(job: DemoJob, want: number): string {
  const [first, second] = job.focus
  if (want >= 0.7) return `Centres on ${first} and ${second}, the kind of work you have led.`
  if (want >= 0.5) return `Overlaps with your backend work, though the ${job.team} remit is adjacent.`
  return `A ${job.jobFunction} role, away from the platform work you have been doing.`
}

/**
 * The assessment a demo role carries, in EXACTLY the shape lib/scoring writes to
 * the person's row for it (person_roles): a want with a reason, and a chance with a cited line for every
 * requirement the résumé shows and a named gap for every one it does not. The chance
 * follows the same rule the product uses (lib/scoring/chance.ts labelChance): no
 * gap is Strong, one is Possible, two or more, or a role in a function the résumé
 * does not evidence, is a Stretch.
 *
 * `source` is 'demo/seed' rather than a model: these verdicts were never produced
 * by one, and labelling them as if they were would be a lie told to whoever
 * inspects the row. Roles with no `want` are returned unassessed.
 */
export function buildDemoFit(job: DemoJob, resume: string, assessedAt: string): DemoFit {
  if (job.want == null) {
    return { assessed_at: null, blocked_reasons: [], want_p: null, want_reason: null, want_detail: null, chance: null, chance_detail: null }
  }
  const lines = resumeLines(resume)
  const requirements: Requirement[] = []
  const checks: RequirementCheck[] = []
  job.focus.forEach((skill, i) => {
    const line = lineShowing(skill, lines)
    requirements.push({ id: `r${i + 1}`, text: skill, kind: 'skill', mustHave: true, quote: skill, origin: 'code' })
    checks.push({ requirement: skill, mustHave: true, status: line ? 'met' : 'not_met', evidence: line ? { line: line.n, quote: line.text.slice(0, 160) } : null })
  })
  // For the roles the person wants most, the skills the résumé lacks are things the posting only
  // mentions in passing (nice to have), so those roles can honestly read Strong.
  const mild = job.want >= 0.85
  job.missing.forEach((skill, i) => {
    requirements.push({ id: `r${job.focus.length + i + 1}`, text: skill, kind: 'skill', mustHave: !mild, quote: skill, origin: 'code' })
    checks.push({ requirement: skill, mustHave: !mild, status: 'not_met', evidence: null })
  })
  // A role in a function the résumé does not evidence is a stretch however the skills line up.
  if (job.jobFunction !== 'engineering') {
    const text = `Experience in ${job.jobFunction}`
    requirements.push({ id: `r${requirements.length + 1}`, text, kind: 'experience', mustHave: true, quote: text, origin: 'code' })
    checks.push({ requirement: text, mustHave: true, status: 'not_met', evidence: null })
  }
  const labelled = labelChance(requirements, checks)
  const chance = labelled.chance === 'cannot_assess' ? null : labelled.chance
  return {
    assessed_at: assessedAt,
    blocked_reasons: [],
    want_p: job.want,
    want_reason: wantReasonFor(job, job.want),
    want_detail: { judge: job.want, embedding: null, stated: job.want, statedKey: null, calibrated: false, nReactions: 0, source: 'demo/seed' },
    chance,
    chance_detail: chance ? { checks, gaps: labelled.gaps, confirm: [], note: labelled.note, resumeKey: null } : null,
  }
}

/** Lookup by slug — throws rather than silently seeding an orphan row. */
export function jobBySlug(slug: string): DemoJob {
  const found = DEMO_JOBS.find((j) => j.slug === slug)
  if (!found) throw new Error(`Unknown demo job slug: ${slug}`)
  return found
}

/** Convenience for the seeder and the tests. */
export function companyForJob(job: DemoJob): DemoCompany {
  return companyBySlug(job.companySlug)
}
