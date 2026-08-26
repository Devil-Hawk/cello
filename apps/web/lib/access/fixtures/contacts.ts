// Eight networking contacts at the seeded employers.
//
// NOBODY HERE CAN BE REACHED, AND THAT IS THE POINT.
//   The demo account can draft and (with the owner's Gmail connected) send
//   outreach. Every address below is therefore under example.com — RFC 2606
//   reserves it, no MX record exists, and mail to it cannot be delivered to a
//   human. Names are invented; none is a public figure.
//
// NO linkedin.com URLS.
//   A plausible linkedin.com/in/<slug> either 404s or, worse, lands on a real
//   stranger who has nothing to do with this demo. The few contacts that carry
//   a profile link point at the (unroutable) demo company's own host instead.
//
// PROVENANCE IS HONEST.
//   contacts.verified stays FALSE on every row. That column means "a provider
//   affirmatively confirmed deliverability" (see the migration comment on
//   20260728000007_contact_provenance.sql) and nothing verified these. A demo
//   that showed a green "verified" badge on a fabricated address would be
//   teaching the viewer to trust a signal we did not earn.

export interface DemoContact {
  slug: string
  companySlug: string
  name: string
  title: string
  /** null for the contacts where the demo should show "no email on file". */
  email: string | null
  /** Never linkedin.com — see the header. null for most. */
  profileUrl: string | null
  /** components/contacts/types.ts Relationship, or the 'sourced' sentinel. */
  relationship: string
  /** Days before "now" they were last contacted; null = never. */
  lastContactDaysAgo: number | null
  notes: string
  /** lib/contacts/sources.ts ContactSource, or null for "entered by hand". */
  source: string | null
  /** 0..1 sourcing confidence; null when the contact was entered by hand. */
  confidence: number | null
  /** Human-readable "how we know this", or null for a manual entry. */
  basis: string | null
}

export const DEMO_CONTACTS: readonly DemoContact[] = [
  {
    slug: 'dana-whitfield',
    companySlug: 'northwind-atlas',
    name: 'Dana Whitfield',
    title: 'Engineering Manager, Data Platform',
    email: 'dana.whitfield@northwind-atlas.example.com',
    profileUrl: null,
    relationship: 'colleague',
    lastContactDaysAgo: 4,
    notes: 'Worked together at Trellis Point. Offered to pass the résumé to the hiring manager.',
    source: null,
    confidence: null,
    basis: null,
  },
  {
    slug: 'priya-nandakumar',
    companySlug: 'northwind-atlas',
    name: 'Priya Nandakumar',
    title: 'Staff Engineer, Query Engine',
    email: null,
    profileUrl: 'https://northwind-atlas.example.com/team/p-nandakumar',
    relationship: 'sourced',
    lastContactDaysAgo: null,
    notes: 'Named as the tech lead in the Query Engine posting. No address on file.',
    source: 'posting',
    confidence: 0.55,
    basis: 'Mentioned by name in the job posting text — no email address was found.',
  },
  {
    slug: 'marcus-oyelaran',
    companySlug: 'petrichor-labs',
    name: 'Marcus Oyelaran',
    title: 'Technical Recruiter',
    email: 'marcus.oyelaran@petrichor-labs.example.com',
    profileUrl: null,
    relationship: 'recruiter',
    lastContactDaysAgo: 2,
    notes: 'Reached out about the Inference role. Asked for availability next week.',
    source: null,
    confidence: null,
    basis: null,
  },
  {
    slug: 'elena-vasquez',
    companySlug: 'tessellate-cloud',
    name: 'Elena Vasquez',
    title: 'Director of Engineering',
    email: 'elena.vasquez@tessellate-cloud.example.com',
    profileUrl: null,
    relationship: 'alumni',
    lastContactDaysAgo: 11,
    notes: 'Cascade Ridge alum, two years ahead. Happy to do a referral once there is a specific req.',
    source: null,
    confidence: null,
    basis: null,
  },
  {
    slug: 'tomas-bergstrom',
    companySlug: 'vantage-loom',
    name: 'Tomás Bergström',
    title: 'Platform Lead, Payments Core',
    email: null,
    profileUrl: null,
    relationship: 'sourced',
    lastContactDaysAgo: null,
    notes: 'Named in the Payments Core dossier. Address pattern for this domain is unconfirmed.',
    source: 'dossier',
    confidence: 0.42,
    basis: 'Named in the company dossier — INFERRED contact, address not found or verified.',
  },
  {
    slug: 'aisha-rahman',
    companySlug: 'quillon-systems',
    name: 'Aisha Rahman',
    title: 'Recruiting Partner, Engineering',
    email: 'aisha.rahman@quillon-systems.example.com',
    profileUrl: null,
    relationship: 'recruiter',
    lastContactDaysAgo: 18,
    notes: 'Screened for a different role last year. Said to reconnect when a staff req opened.',
    source: null,
    confidence: null,
    basis: null,
  },
  {
    slug: 'jonah-fielding',
    companySlug: 'larkspur-robotics',
    name: 'Jonah Fielding',
    title: 'Engineering Manager, Fleet Platform',
    email: 'jonah.fielding@larkspur-robotics.example.com',
    profileUrl: null,
    relationship: 'linkedin_connection',
    lastContactDaysAgo: 25,
    notes: 'Connected after a conference talk on fleet telemetry. Warm but not close.',
    source: 'pattern',
    confidence: 0.71,
    basis: 'Address pattern inferred from a known-good address at this domain — INFERRED, not verified.',
  },
  {
    slug: 'wren-castellanos',
    companySlug: 'fernwood-health',
    name: 'Wren Castellanos',
    title: 'Senior Software Engineer, Patient Platform',
    email: 'wren.castellanos@fernwood-health.example.com',
    profileUrl: null,
    relationship: 'colleague',
    lastContactDaysAgo: 7,
    notes: 'Former teammate at Halden & Reeve. Already flagged the Patient Platform opening internally.',
    source: null,
    confidence: null,
    basis: null,
  },
]

/** Lookup by slug — throws rather than silently seeding an orphan row. */
export function contactBySlug(slug: string): DemoContact {
  const found = DEMO_CONTACTS.find((c) => c.slug === slug)
  if (!found) throw new Error(`Unknown demo contact slug: ${slug}`)
  return found
}
