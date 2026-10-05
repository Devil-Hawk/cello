// Curated directory of well-known company domains → proper display names.
//
// Framework-free (no next/* imports) so it can be imported from route handlers,
// client components, and scripts alike. This is the single source of truth for
// the KNOWN_COMPANIES map — it used to be duplicated in
// app/api/companies/verify/route.ts and app/api/companies/fix-names/route.ts;
// verify/route.ts and app/api/companies/resolve/route.ts both import it from
// here now. (fix-names/route.ts keeps its own older copy — it's owned by a
// different workstream and wasn't touched.)

import type { AtsProviderId } from '../ats/types'

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
  // A board checked by hand to be this employer's own. Known employers are never
  // slug-guessed (a namesake's board answers for the same name), so this is the
  // only board Cello takes for them without their own site linking to it.
  board?: { provider: AtsProviderId; token: string }
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
  'openai.com': { name: 'OpenAI', board: { provider: 'ashby', token: 'openai' } },
  'anthropic.com': { name: 'Anthropic', board: { provider: 'greenhouse', token: 'anthropic' } },
  'stripe.com': { name: 'Stripe', board: { provider: 'greenhouse', token: 'stripe' } },
  'airbnb.com': { name: 'Airbnb', board: { provider: 'greenhouse', token: 'airbnb' } },
  'uber.com': { name: 'Uber', careerUrl: 'https://www.uber.com/us/en/careers/list/' },
  'lyft.com': { name: 'Lyft', careerUrl: 'https://www.lyft.com/careers', board: { provider: 'greenhouse', token: 'lyft' } },
  'salesforce.com': { name: 'Salesforce', careerUrl: 'https://careers.salesforce.com/en/jobs/' },
  'adobe.com': { name: 'Adobe', careerUrl: 'https://careers.adobe.com/us/en/search-results' },
  'nvidia.com': { name: 'NVIDIA', careerUrl: 'https://www.nvidia.com/en-us/about-nvidia/careers/' },
  'tesla.com': { name: 'Tesla', careerUrl: 'https://www.tesla.com/careers/search/' },
  'spacex.com': { name: 'SpaceX', careerUrl: 'https://www.spacex.com/careers/', board: { provider: 'greenhouse', token: 'spacex' } },
  'twitter.com': { name: 'X (Twitter)', careerUrl: 'https://careers.x.com/en' },
  'x.com': { name: 'X', careerUrl: 'https://careers.x.com/en' },
  'linkedin.com': { name: 'LinkedIn', careerUrl: 'https://careers.linkedin.com/jobs' },
  'dropbox.com': { name: 'Dropbox', board: { provider: 'greenhouse', token: 'dropbox' } },
  'spotify.com': { name: 'Spotify', board: { provider: 'lever', token: 'spotify' } },
  'snap.com': { name: 'Snap', careerUrl: 'https://careers.snap.com/jobs' },
  'snapchat.com': { name: 'Snap', careerUrl: 'https://careers.snap.com/jobs' },
  'tiktok.com': { name: 'TikTok' },
  'bytedance.com': { name: 'ByteDance' },
  'palantir.com': { name: 'Palantir', board: { provider: 'lever', token: 'palantir' } },
  'coinbase.com': { name: 'Coinbase', board: { provider: 'greenhouse', token: 'coinbase' } },
  'robinhood.com': { name: 'Robinhood', board: { provider: 'greenhouse', token: 'robinhood' } },
  'databricks.com': { name: 'Databricks', board: { provider: 'greenhouse', token: 'databricks' } },
  'snowflake.com': { name: 'Snowflake', board: { provider: 'ashby', token: 'snowflake' } },
  'figma.com': { name: 'Figma', board: { provider: 'greenhouse', token: 'figma' } },
  'notion.so': { name: 'Notion', board: { provider: 'ashby', token: 'notion' } },
  'slack.com': { name: 'Slack' },
  'zoom.us': { name: 'Zoom' },
  'twitch.tv': { name: 'Twitch', board: { provider: 'greenhouse', token: 'twitch' } },
  'discord.com': { name: 'Discord', board: { provider: 'greenhouse', token: 'discord' } },
  'reddit.com': { name: 'Reddit', board: { provider: 'greenhouse', token: 'reddit' } },
  'pinterest.com': { name: 'Pinterest', board: { provider: 'greenhouse', token: 'pinterest' } },
  'instacart.com': { name: 'Instacart', board: { provider: 'greenhouse', token: 'instacart' } },
  'doordash.com': { name: 'DoorDash', board: { provider: 'greenhouse', token: 'doordashusa' } },
  'grubhub.com': { name: 'Grubhub' },
  'wework.com': { name: 'WeWork' },
  'plaid.com': { name: 'Plaid', board: { provider: 'ashby', token: 'plaid' } },
  'square.com': { name: 'Square', board: { provider: 'greenhouse', token: 'block' } },
  'block.xyz': { name: 'Block', board: { provider: 'greenhouse', token: 'block' } },
  'affirm.com': { name: 'Affirm', board: { provider: 'greenhouse', token: 'affirm' } },
  'chime.com': { name: 'Chime', board: { provider: 'greenhouse', token: 'chime' } },
  'brex.com': { name: 'Brex', board: { provider: 'greenhouse', token: 'brex' } },
  'ramp.com': { name: 'Ramp', board: { provider: 'ashby', token: 'ramp' } },
  'rippling.com': { name: 'Rippling' },
  'gusto.com': { name: 'Gusto', board: { provider: 'greenhouse', token: 'gusto' } },
  'lattice.com': { name: 'Lattice', board: { provider: 'greenhouse', token: 'lattice' } },
  'airtable.com': { name: 'Airtable', board: { provider: 'greenhouse', token: 'airtable' } },
  'asana.com': { name: 'Asana', board: { provider: 'greenhouse', token: 'asana' } },
  'monday.com': { name: 'monday.com' },
  'atlassian.com': { name: 'Atlassian' },
  'github.com': { name: 'GitHub' },
  'gitlab.com': { name: 'GitLab', board: { provider: 'greenhouse', token: 'gitlab' } },
  'vercel.com': { name: 'Vercel', board: { provider: 'greenhouse', token: 'vercel' } },
  'supabase.com': { name: 'Supabase', board: { provider: 'ashby', token: 'supabase' } },
  'cloudflare.com': { name: 'Cloudflare', board: { provider: 'greenhouse', token: 'cloudflare' } },
  'datadog.com': { name: 'Datadog', board: { provider: 'greenhouse', token: 'datadog' } },
  'datadoghq.com': { name: 'Datadog', board: { provider: 'greenhouse', token: 'datadog' } },
  'elastic.co': { name: 'Elastic', board: { provider: 'greenhouse', token: 'elastic' } },
  'mongodb.com': { name: 'MongoDB', board: { provider: 'greenhouse', token: 'mongodb' } },
  'hashicorp.com': { name: 'HashiCorp' },
  'intercom.com': { name: 'Intercom', board: { provider: 'greenhouse', token: 'intercom' } },
  'posthog.com': { name: 'PostHog', board: { provider: 'ashby', token: 'posthog' } },
  'scale.com': { name: 'Scale AI', board: { provider: 'greenhouse', token: 'scaleai' } },
  'confluent.io': { name: 'Confluent', board: { provider: 'ashby', token: 'confluent' } },
  // Real boards that give nothing to verify them by (no declared site, no posting names the
  // company's, careers page renders them by script), checked by hand on 2026-10-05.
  'notion.com': { name: 'Notion', board: { provider: 'ashby', token: 'notion' } },
  'typeform.com': { name: 'Typeform', board: { provider: 'greenhouse', token: 'typeform' } },
  'lucidsoftware.com': { name: 'Lucid Software', board: { provider: 'greenhouse', token: 'lucidsoftware' } },
  'lucid.co': { name: 'Lucid Software', board: { provider: 'greenhouse', token: 'lucidsoftware' } },
  'smartsheet.com': { name: 'Smartsheet', board: { provider: 'greenhouse', token: 'smartsheet' } },
  'gemini.com': { name: 'Gemini', board: { provider: 'greenhouse', token: 'gemini' } },
  'canva.com': { name: 'Canva', board: { provider: 'smartrecruiters', token: 'canva' } },
  'wise.com': { name: 'Wise', board: { provider: 'smartrecruiters', token: 'wise' } },
  'planetscale.com': { name: 'PlanetScale', board: { provider: 'greenhouse', token: 'planetscale' } },
  'loopreturns.com': { name: 'Loop Returns', board: { provider: 'lever', token: 'loopreturns' } },
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

export const SUFFIX_WORDS = new Set([
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

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * A big, well-known employer: its domain, its careers-URL host or its name is in
 * the directory above. Such a company is never slug-guessed onto a job board.
 */
export function isKnownEmployer(input: {
  domain?: string | null
  name?: string | null
  careerUrl?: string | null
}): boolean {
  const domain = hostOf(input.domain)
  if (domain && lookupKnownCompanyByDomain(domain)) return true
  if (input.name && lookupKnownCompanyByName(input.name)) return true
  const host = hostOf(input.careerUrl)
  return !!host && Object.keys(KNOWN_COMPANIES).some((d) => d === host || hostOf(KNOWN_COMPANIES[d].careerUrl) === host)
}

/**
 * The hand-checked board for a known employer, by domain or careers host only
 * (never by name: "Amazon" the namesake is not Amazon).
 */
export function knownBoard(input: {
  domain?: string | null
  careerUrl?: string | null
}): { provider: AtsProviderId; token: string } | null {
  for (const host of [hostOf(input.domain), hostOf(input.careerUrl)]) {
    const board = host ? lookupKnownCompanyByDomain(host)?.board : undefined
    if (board) return board
  }
  return null
}
