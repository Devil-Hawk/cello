// Strict location rules for suggested companies.
//
// Ingest keeps a lead whose country is unknown (matchesTargeting in
// lib/sources/util.ts), which is right for filling a jobs list and wrong here:
// a suggestion says "this company is hiring for you", so a role that cannot be
// shown to be in the right place does not count. When the person has location
// preferences, a role must be provably inside them; with no preferences,
// everything passes.

import { parseLocation } from '../jobs/classify'
import { resolveTargeting } from '../targeting'

export interface LocationPrefs {
  /** ISO alpha-2 codes, uppercase. Empty means any country. */
  countries: string[]
  /** Only remote roles count. */
  remoteOnly: boolean
  /** Remote roles are acceptable at all (false only for an on-site preference). */
  remoteAllowed: boolean
  /** Free-text places (cities, states, countries), lowercase, "remote" excluded. */
  cities: string[]
}

export interface Place {
  location?: string | null
  /** YC style region tags, for example ["United States of America", "Remote"]. */
  regions?: string[]
}

export interface Verdict {
  ok: boolean
  /** A short reason, for tests and debugging only. */
  why: string
}

/** Read location preferences out of profiles.preferences. Never throws. */
export function prefsFromProfile(preferences: unknown): LocationPrefs {
  const t = resolveTargeting(preferences)
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>
  const remotePreference = typeof p.remotePreference === 'string' ? p.remotePreference : 'any'
  const places = Array.isArray(p.preferredLocations) ? (p.preferredLocations as unknown[]) : []
  return {
    countries: t.countries,
    remoteOnly: t.remoteOnly || remotePreference === 'remote',
    remoteAllowed: remotePreference !== 'onsite',
    cities: places
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.toLowerCase().trim())
      .filter((l) => l && !l.includes('remote')),
  }
}

const EUROPE = ['GB', 'IE', 'DE', 'FR', 'NL', 'BE', 'ES', 'PT', 'IT', 'AT', 'CH', 'PL', 'CZ', 'SE', 'NO', 'DK', 'FI', 'IS', 'EE', 'LV', 'LT', 'RO', 'BG', 'GR', 'HU', 'HR', 'RS', 'SI', 'SK', 'UA', 'TR']
const AMERICAS = ['US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR']
/** Region words and the countries they cover. A remote role limited to a region is only
 *  in scope when a target country sits inside that region. */
const REGIONS: Record<string, string[]> = {
  'north america': ['US', 'CA', 'MX'],
  americas: AMERICAS,
  amer: AMERICAS,
  latam: ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR'],
  'latin america': ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR'],
  europe: EUROPE,
  eu: EUROPE,
  emea: [...EUROPE, 'AE', 'IL', 'SA', 'QA', 'EG', 'NG', 'KE', 'ZA'],
  apac: ['AU', 'NZ', 'SG', 'JP', 'KR', 'CN', 'HK', 'TW', 'TH', 'VN', 'ID', 'MY', 'PH', 'IN'],
  'asia pacific': ['AU', 'NZ', 'SG', 'JP', 'KR', 'CN', 'HK', 'TW', 'TH', 'VN', 'ID', 'MY', 'PH', 'IN'],
  asia: ['JP', 'KR', 'CN', 'HK', 'TW', 'TH', 'VN', 'ID', 'MY', 'PH', 'IN', 'SG'],
}

const WORLDWIDE = /\b(worldwide|world wide|anywhere|global|globally)\b/
const REMOTE_FILLER = /\b(fully|100|hybrid|remote|only|work|from|home|wfh|flexible|friendly|distributed|first|in|or)\b/g

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9% ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function mentionsPlace(text: string, place: string): boolean {
  const n = norm(text)
  const p = norm(place)
  return !!p && new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(n)
}

/** Every country a location text names, splitting "US or Canada" style lists. */
function countriesNamed(text: string): string[] {
  const out = new Set<string>()
  for (const seg of text.split(/[,;/|]| or | and |\+|\(|\)|\s-\s/i)) {
    const c = parseLocation(seg).country
    if (c) out.add(c)
  }
  const whole = parseLocation(text).country
  if (whole) out.add(whole)
  return [...out]
}

/** Is a REMOTE role's stated scope inside the person's countries? */
function remoteScopeOk(text: string, countries: string[]): { ok: boolean; why: string } {
  const n = norm(text)
  if (WORLDWIDE.test(n)) return { ok: true, why: 'remote, worldwide' }
  if (countriesNamed(text).some((c) => countries.includes(c))) return { ok: true, why: 'remote, names a target country' }
  for (const [word, covered] of Object.entries(REGIONS)) {
    if (mentionsPlace(n, word)) {
      return covered.some((c) => countries.includes(c))
        ? { ok: true, why: `remote, ${word} covers a target country` }
        : { ok: false, why: `remote, limited to ${word}` }
    }
  }
  const remainder = n.replace(REMOTE_FILLER, ' ').replace(/[^a-z]+/g, ' ').trim()
  if (remainder === '') return { ok: true, why: 'remote with no stated limit' }
  return { ok: false, why: `remote, limited to "${remainder}"` }
}

function evaluate(text: string, forceRemote: boolean, prefs: LocationPrefs): Verdict {
  const parsed = parseLocation(text)
  const remote = parsed.isRemote || forceRemote
  const cityMatch = prefs.cities.some((c) => mentionsPlace(text, c))

  if (prefs.remoteOnly && !remote) return { ok: false, why: 'not remote' }

  if (remote) {
    if (cityMatch) return { ok: true, why: 'names a preferred place' }
    if (!prefs.remoteAllowed) return { ok: false, why: 'remote not wanted' }
    if (prefs.countries.length === 0) return { ok: true, why: 'remote, no country limit' }
    return remoteScopeOk(text, prefs.countries)
  }

  if (prefs.cities.length > 0) return cityMatch ? { ok: true, why: 'in a preferred place' } : { ok: false, why: 'not in a preferred place' }
  if (prefs.countries.length > 0) {
    if (!parsed.country) return { ok: false, why: 'location unknown' }
    return prefs.countries.includes(parsed.country) ? { ok: true, why: `in ${parsed.country}` } : { ok: false, why: `in ${parsed.country}` }
  }
  return { ok: true, why: 'no location limit' }
}

/**
 * Is this place inside the person's location preferences? A semicolon splits a
 * list of offices (YC's all_locations); any one office in scope is enough. A
 * YC "Remote" or "Fully Remote" region makes the company remote, scoped by the
 * country regions listed next to it.
 */
export function locationVerdict(place: Place, prefs: LocationPrefs): Verdict {
  const constrained = prefs.remoteOnly || prefs.countries.length > 0 || prefs.cities.length > 0
  if (!constrained) return { ok: true, why: 'no preferences' }

  const regions = place.regions ?? []
  const remoteRegion = regions.some((r) => /^(fully )?remote$/i.test(r.trim()))
  const texts = (place.location ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean)
  if (remoteRegion) texts.push(`remote ${regions.filter((r) => !/remote/i.test(r)).join(' ')}`.trim())
  if (texts.length === 0) return { ok: false, why: 'location unknown' }

  let last: Verdict = { ok: false, why: 'location unknown' }
  for (const t of texts) {
    const v = evaluate(t, false, prefs)
    if (v.ok) return v
    last = v
  }
  return last
}
