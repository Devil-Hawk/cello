// Curated directory of well-known company domains → proper display names.
//
// Framework-free (no next/* imports) so it can be imported from route handlers,
// client components, and scripts alike. This is the single source of truth for
// the KNOWN_COMPANIES map — it used to be duplicated in
// app/api/companies/verify/route.ts and app/api/companies/fix-names/route.ts;
// verify/route.ts and app/api/companies/resolve/route.ts both import it from
// here now. (fix-names/route.ts keeps its own older copy — it's owned by a
// different workstream and wasn't touched.)

export interface KnownCompany {
  name: string
  logo?: string
  // Hand-curated, stable careers URL — ONLY set for companies whose ATS is
  // not one of the ones /api/companies/resolve can probe (Greenhouse/Lever/
  // Ashby), i.e. large enterprises running a homegrown or Workday-style board
  // (Amazon, Google, Meta, Apple, Microsoft, Netflix, Tesla, ...). Without
  // this, those companies' "known" candidate always came back with
  // careerUrl: null (name/domain only) since step (a) is free/no-network and
  // step (b)'s probes have nothing to find — see resolve/route.ts. Always a
  // real page with a path (never a bare homepage — matches isBareHomepage's
  // invariant there). Companies already reliably found by the ATS probes
  // (Stripe, Notion, Figma, etc.) intentionally have no entry here — the
  // probe is the source of truth for those and stays network-verified.
  careerUrl?: string
}

export const KNOWN_COMPANIES: Record<string, KnownCompany> = {
  'amazon.jobs': { name: 'Amazon', careerUrl: 'https://www.amazon.jobs/en/search' },
  'amazon.com': { name: 'Amazon', careerUrl: 'https://www.amazon.jobs/en/search' },
  'google.com': { name: 'Google', careerUrl: 'https://www.google.com/about/careers/applications/jobs/results/' },
  'careers.google.com': { name: 'Google', careerUrl: 'https://www.google.com/about/careers/applications/jobs/results/' },
  'meta.com': { name: 'Meta', careerUrl: 'https://www.metacareers.com/jobs/' },
  'facebook.com': { name: 'Meta', careerUrl: 'https://www.metacareers.com/jobs/' },
  'apple.com': { name: 'Apple', careerUrl: 'https://jobs.apple.com/en-us/search' },
  'jobs.apple.com': { name: 'Apple', careerUrl: 'https://jobs.apple.com/en-us/search' },
  'microsoft.com': { name: 'Microsoft', careerUrl: 'https://jobs.careers.microsoft.com/global/en/search' },
  'careers.microsoft.com': { name: 'Microsoft', careerUrl: 'https://jobs.careers.microsoft.com/global/en/search' },
  'netflix.com': { name: 'Netflix', careerUrl: 'https://explore.jobs.netflix.net/careers' },
  'jobs.netflix.com': { name: 'Netflix', careerUrl: 'https://explore.jobs.netflix.net/careers' },
  'openai.com': { name: 'OpenAI' },
  'anthropic.com': { name: 'Anthropic' },
  'stripe.com': { name: 'Stripe' },
  'airbnb.com': { name: 'Airbnb' },
  'uber.com': { name: 'Uber', careerUrl: 'https://www.uber.com/us/en/careers/list/' },
  'lyft.com': { name: 'Lyft', careerUrl: 'https://www.lyft.com/careers' },
  'salesforce.com': { name: 'Salesforce', careerUrl: 'https://careers.salesforce.com/en/jobs/' },
  'adobe.com': { name: 'Adobe', careerUrl: 'https://careers.adobe.com/us/en/search-results' },
  'nvidia.com': { name: 'NVIDIA', careerUrl: 'https://www.nvidia.com/en-us/about-nvidia/careers/' },
  'tesla.com': { name: 'Tesla', careerUrl: 'https://www.tesla.com/careers/search/' },
  'spacex.com': { name: 'SpaceX', careerUrl: 'https://www.spacex.com/careers/' },
  'twitter.com': { name: 'X (Twitter)', careerUrl: 'https://careers.x.com/en' },
  'x.com': { name: 'X', careerUrl: 'https://careers.x.com/en' },
  'linkedin.com': { name: 'LinkedIn', careerUrl: 'https://careers.linkedin.com/jobs' },
  'dropbox.com': { name: 'Dropbox' },
  'spotify.com': { name: 'Spotify' },
  'snap.com': { name: 'Snap', careerUrl: 'https://careers.snap.com/jobs' },
  'snapchat.com': { name: 'Snap', careerUrl: 'https://careers.snap.com/jobs' },
  'tiktok.com': { name: 'TikTok' },
  'bytedance.com': { name: 'ByteDance' },
  'palantir.com': { name: 'Palantir' },
  'coinbase.com': { name: 'Coinbase' },
  'robinhood.com': { name: 'Robinhood' },
  'databricks.com': { name: 'Databricks' },
  'snowflake.com': { name: 'Snowflake' },
  'figma.com': { name: 'Figma' },
  'notion.so': { name: 'Notion' },
  'slack.com': { name: 'Slack' },
  'zoom.us': { name: 'Zoom' },
  'twitch.tv': { name: 'Twitch' },
  'discord.com': { name: 'Discord' },
  'reddit.com': { name: 'Reddit' },
  'pinterest.com': { name: 'Pinterest' },
  'instacart.com': { name: 'Instacart' },
  'doordash.com': { name: 'DoorDash' },
  'grubhub.com': { name: 'Grubhub' },
  'wework.com': { name: 'WeWork' },
  'plaid.com': { name: 'Plaid' },
  'square.com': { name: 'Square' },
  'block.xyz': { name: 'Block' },
  'affirm.com': { name: 'Affirm' },
  'chime.com': { name: 'Chime' },
  'brex.com': { name: 'Brex' },
  'ramp.com': { name: 'Ramp' },
  'rippling.com': { name: 'Rippling' },
  'gusto.com': { name: 'Gusto' },
  'lattice.com': { name: 'Lattice' },
  'airtable.com': { name: 'Airtable' },
  'asana.com': { name: 'Asana' },
  'monday.com': { name: 'monday.com' },
  'atlassian.com': { name: 'Atlassian' },
  'github.com': { name: 'GitHub' },
  'gitlab.com': { name: 'GitLab' },
  'vercel.com': { name: 'Vercel' },
  'supabase.com': { name: 'Supabase' },
  'cloudflare.com': { name: 'Cloudflare' },
  'datadog.com': { name: 'Datadog' },
  'elastic.co': { name: 'Elastic' },
  'mongodb.com': { name: 'MongoDB' },
  'hashicorp.com': { name: 'HashiCorp' },
  'confluent.io': { name: 'Confluent' },
}

/** Domain → known company, tolerating a jobs./careers. subdomain prefix. */
export function lookupKnownCompanyByDomain(domain: string): KnownCompany | null {
  const key = domain.trim().toLowerCase()
  return (
    KNOWN_COMPANIES[key] ||
    KNOWN_COMPANIES[key.replace(/^jobs\./, '')] ||
    KNOWN_COMPANIES[key.replace(/^careers\./, '')] ||
    null
  )
}

// Reverse index (proper name, lowercased → domain), built once at module load.
// Several domains can map to the same proper name (snap.com/snapchat.com →
// "Snap"); the first one encountered above wins, which is fine — we only need
// ONE representative domain per name for the resolve flow.
const NAME_TO_DOMAIN: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [domain, info] of Object.entries(KNOWN_COMPANIES)) {
    const key = info.name.trim().toLowerCase()
    if (!map.has(key)) map.set(key, domain)
  }
  return map
})()

const SUFFIX_WORDS = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp',
  'ltd', 'limited', 'gmbh', 'plc', 'sa', 'ag', 'nv', 'bv', 'srl', 'pty',
  'group', 'holdings', 'holding',
])

/** "Amazon Inc." / "Cello GmbH" / "Acme Corp" → "Amazon" / "Cello" / "Acme". */
export function stripCompanySuffix(name: string): string {
  const tokens = name.trim().split(/\s+/)
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1].replace(/[.,]+$/, '').toLowerCase()
    if (!SUFFIX_WORDS.has(last)) break
    tokens.pop()
  }
  const result = tokens.join(' ').trim()
  return result || name.trim()
}

/** Name → known company (exact match, then suffix-stripped match). Case-insensitive. */
export function lookupKnownCompanyByName(query: string): { name: string; domain: string; careerUrl?: string } | null {
  const raw = query.trim()
  if (!raw) return null
  const domain = NAME_TO_DOMAIN.get(raw.toLowerCase()) ?? NAME_TO_DOMAIN.get(stripCompanySuffix(raw).toLowerCase())
  if (!domain) return null
  const info = KNOWN_COMPANIES[domain]
  return { name: info.name, domain, careerUrl: info.careerUrl }
}

/** Google favicon service, normalizing jobs./careers. subdomains to the apex domain. */
export function faviconForDomain(domain: string): string {
  const logoDomain = domain.replace(/\.(jobs|careers)$/, '.com').replace(/^(jobs|careers)\./, '')
  return `https://www.google.com/s2/favicons?domain=${logoDomain}&sz=128`
}
