// The twelve fictional employers the demo workspace tracks.
//
// NAMES ARE INVENTED ON PURPOSE.
//   Seeding "Stripe" or "Datadog" with fabricated openings would put words in a
//   real company's mouth: the demo shows job descriptions, salary bands and
//   match verdicts, and none of those would be theirs. Every name below is
//   made up, every domain is under example.com (RFC 2606 — reserved, cannot be
//   registered, resolves nowhere), and every seeded posting says so in its own
//   description. A person looking at this data can tell in one glance that it
//   is not a real job market.
//
// LOGOS ARE INLINE SVG, NOT A FAVICON LOOKUP.
//   components/companies/company-logo.tsx falls back to Google's favicon
//   service when logo_url is null. For example.com hosts that returns a generic
//   globe twelve times over, and it ships our fake domains to a third party for
//   no benefit. A deterministic monogram data: URI renders offline, looks
//   deliberate, and keeps the demo self-contained.

/** Which ingest adapter the company's jobs claim to have come from. */
export type DemoSource = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'scraper'

export interface DemoCompany {
  /** Stable key used to derive the row id and to link jobs/contacts. */
  slug: string
  name: string
  domain: string
  /** Days before "now" the company was added, so the list has a natural order. */
  addedDaysAgo: number
  /** Hours before "now" the company was last scraped. */
  scrapedHoursAgo: number
  isDream: boolean
  source: DemoSource
  /** Monogram background. Muted neutrals only — see monogramLogo(). */
  tone: string
  blurb: string
}

/**
 * Monogram background tones.
 *
 * NOT the design system's signal colours: app/globals.css is emphatic that
 * --accent (#EA580C) means "live" everywhere in this product and --brand
 * (#14555A) is the logo alone. A company mark is neither, so these are twelve
 * desaturated neutrals that read as third-party brand imagery rather than as
 * product state.
 */
const TONES = [
  '#4B5563',
  '#57534E',
  '#475569',
  '#5B5F6B',
  '#4C5A63',
  '#5A5147',
  '#525B66',
  '#4F4A55',
  '#586067',
  '#4A5259',
  '#615A52',
  '#535A54',
] as const

/**
 * A framed monogram as a `data:` URI. Deterministic: the same company always
 * renders the same mark, which is what makes the fixture snapshot-testable.
 */
export function monogramLogo(name: string, tone: string): string {
  const initials =
    name
      .split(/[\s&]+/)
      .filter((word) => /^[A-Za-z]/.test(word))
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join('') || '?'

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">` +
    `<rect width="64" height="64" rx="14" fill="${tone}"/>` +
    `<text x="32" y="41" text-anchor="middle" fill="#F5F3EF" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="25" font-weight="600">` +
    `${initials}</text></svg>`

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** Careers page for a demo company. Unroutable by construction. */
export function careerUrl(company: DemoCompany): string {
  return `https://${company.domain}/careers`
}

export const DEMO_COMPANIES: readonly DemoCompany[] = [
  {
    slug: 'northwind-atlas',
    name: 'Northwind Atlas',
    domain: 'northwind-atlas.example.com',
    addedDaysAgo: 26,
    scrapedHoursAgo: 3,
    isDream: true,
    source: 'greenhouse',
    tone: TONES[0],
    blurb: 'Warehouse-native analytics platform. Series C, ~380 people, Seattle HQ.',
  },
  {
    slug: 'larkspur-robotics',
    name: 'Larkspur Robotics',
    domain: 'larkspur-robotics.example.com',
    addedDaysAgo: 24,
    scrapedHoursAgo: 5,
    isDream: false,
    source: 'lever',
    tone: TONES[1],
    blurb: 'Warehouse automation hardware plus the fleet software that runs it.',
  },
  {
    slug: 'vantage-loom',
    name: 'Vantage Loom',
    domain: 'vantage-loom.example.com',
    addedDaysAgo: 23,
    scrapedHoursAgo: 4,
    isDream: true,
    source: 'greenhouse',
    tone: TONES[2],
    blurb: 'Payments infrastructure for embedded finance. Series B, New York.',
  },
  {
    slug: 'fernwood-health',
    name: 'Fernwood Health',
    domain: 'fernwood-health.example.com',
    addedDaysAgo: 21,
    scrapedHoursAgo: 9,
    isDream: false,
    source: 'ashby',
    tone: TONES[3],
    blurb: 'Care-coordination software for multi-site clinics. Chicago, ~200 people.',
  },
  {
    slug: 'quillon-systems',
    name: 'Quillon Systems',
    domain: 'quillon-systems.example.com',
    addedDaysAgo: 19,
    scrapedHoursAgo: 7,
    isDream: false,
    source: 'greenhouse',
    tone: TONES[4],
    blurb: 'Detection and response tooling for cloud-native estates. Austin.',
  },
  {
    slug: 'halcyon-freight',
    name: 'Halcyon Freight',
    domain: 'halcyon-freight.example.com',
    addedDaysAgo: 17,
    scrapedHoursAgo: 11,
    isDream: false,
    source: 'workday',
    tone: TONES[5],
    blurb: 'Freight brokerage with an in-house routing and pricing platform. Denver.',
  },
  {
    slug: 'petrichor-labs',
    name: 'Petrichor Labs',
    domain: 'petrichor-labs.example.com',
    addedDaysAgo: 15,
    scrapedHoursAgo: 2,
    isDream: true,
    source: 'ashby',
    tone: TONES[6],
    blurb: 'Applied AI research lab shipping inference infrastructure. San Francisco.',
  },
  {
    slug: 'sable-market',
    name: 'Sable Market',
    domain: 'sable-market.example.com',
    addedDaysAgo: 13,
    scrapedHoursAgo: 14,
    isDream: false,
    source: 'lever',
    tone: TONES[7],
    blurb: 'Curated resale marketplace. ~600 people, Los Angeles.',
  },
  {
    slug: 'tessellate-cloud',
    name: 'Tessellate Cloud',
    domain: 'tessellate-cloud.example.com',
    addedDaysAgo: 11,
    scrapedHoursAgo: 6,
    isDream: true,
    source: 'greenhouse',
    tone: TONES[8],
    blurb: 'Managed container platform and edge network. Portland, remote-first.',
  },
  {
    slug: 'orchid-ledger',
    name: 'Orchid Ledger',
    domain: 'orchid-ledger.example.com',
    addedDaysAgo: 9,
    scrapedHoursAgo: 20,
    isDream: false,
    source: 'lever',
    tone: TONES[9],
    blurb: 'Accounting and close automation for mid-market finance teams. Toronto.',
  },
  {
    slug: 'ironvale-energy',
    name: 'Ironvale Energy',
    domain: 'ironvale-energy.example.com',
    addedDaysAgo: 7,
    scrapedHoursAgo: 16,
    isDream: false,
    source: 'workday',
    tone: TONES[10],
    blurb: 'Grid analytics and demand response for utilities. Pittsburgh.',
  },
  {
    slug: 'bluestem-media',
    name: 'Bluestem Media',
    domain: 'bluestem-media.example.com',
    addedDaysAgo: 5,
    scrapedHoursAgo: 26,
    isDream: false,
    source: 'scraper',
    tone: TONES[11],
    blurb: 'Streaming service for independent film and documentary. Atlanta.',
  },
]

/** Lookup by slug — throws rather than silently seeding an orphan row. */
export function companyBySlug(slug: string): DemoCompany {
  const found = DEMO_COMPANIES.find((c) => c.slug === slug)
  if (!found) throw new Error(`Unknown demo company slug: ${slug}`)
  return found
}
