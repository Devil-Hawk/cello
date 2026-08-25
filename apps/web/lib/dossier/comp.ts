// Compensation intelligence for the dossier — FREE sources only.
//
// Precedence:
//   high   -> derived from FIRST-PARTY posted salary_range on this company's jobs
//             (data Cello already collected from the company's own postings).
//   medium -> a small, shipped public baseline by role family (rough US tech ranges).
//   low    -> nothing usable; ranges omitted.
//
// We NEVER scrape levels.fyi / Glassdoor / any paid or login-walled vendor.
// Every result carries an explicit `confidence` so the UI can caveat it.

import type { CompIntel } from './store'

const MIN_PLAUSIBLE = 10_000
const MAX_PLAUSIBLE = 2_000_000

/**
 * Extract dollar amounts from a free-text salary string. Handles "$120,000",
 * "120k", "120K-150K", "$1.2m". Bare numbers are only kept when unambiguous
 * (>= 1000, e.g. "120000") so tokens like "8 years" never leak in.
 */
export function parseSalaryNumbers(input: string | null | undefined): number[] {
  if (!input) return []
  const out: number[] = []
  const re = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const raw = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(raw)) continue
    const suffix = m[2]?.toLowerCase()
    let value: number
    if (suffix === 'k') value = raw * 1_000
    else if (suffix === 'm') value = raw * 1_000_000
    else if (raw >= 1_000) value = raw
    else continue // ambiguous bare number (e.g. "8") — skip
    if (value >= MIN_PLAUSIBLE && value <= MAX_PLAUSIBLE) out.push(Math.round(value))
  }
  return out
}

// Rough public US tech baselines (annual USD), by coarse role family. These are
// deliberately wide, medium-confidence fallbacks — not a quote for any one role.
interface Baseline {
  low: number
  high: number
  match: RegExp
}
const BASELINES: Baseline[] = [
  { match: /\b(staff|principal|lead)\b/i, low: 180_000, high: 320_000 },
  { match: /\b(senior|sr\.?)\b.*\b(engineer|developer|swe)\b/i, low: 150_000, high: 250_000 },
  { match: /\b(engineer|developer|swe|software)\b/i, low: 110_000, high: 190_000 },
  { match: /\b(data scientist|machine learning|ml|ai)\b/i, low: 130_000, high: 230_000 },
  { match: /\b(data|analytics)\b.*\b(engineer|analyst)\b/i, low: 110_000, high: 185_000 },
  { match: /\b(product manager|pm|product)\b/i, low: 120_000, high: 210_000 },
  { match: /\b(design|ux|ui)\b/i, low: 100_000, high: 175_000 },
  { match: /\b(manager|director|head of)\b/i, low: 150_000, high: 280_000 },
  { match: /\b(sales|account executive|ae)\b/i, low: 80_000, high: 180_000 },
  { match: /\b(marketing|growth)\b/i, low: 85_000, high: 165_000 },
]

function baselineFromTitles(titles: string[]): CompIntel | null {
  for (const t of titles) {
    for (const b of BASELINES) {
      if (b.match.test(t)) {
        return {
          rangeLow: b.low,
          rangeHigh: b.high,
          source: 'Public role-family baseline (rough US tech range)',
          confidence: 'medium',
        }
      }
    }
  }
  return null
}

/**
 * Build comp_intel from a company's own posted jobs. Prefers first-party posted
 * salary ranges (high confidence); falls back to a role-family baseline (medium);
 * otherwise returns a low-confidence, range-less result.
 */
export function computeCompIntel(
  jobs: { salary_range: string | null; title?: string | null }[]
): CompIntel {
  const nums: number[] = []
  let postingsWithSalary = 0
  for (const j of jobs) {
    const parsed = parseSalaryNumbers(j.salary_range)
    if (parsed.length > 0) {
      postingsWithSalary++
      nums.push(...parsed)
    }
  }

  if (nums.length > 0) {
    const rangeLow = Math.min(...nums)
    const rangeHigh = Math.max(...nums)
    return {
      rangeLow,
      rangeHigh: rangeHigh === rangeLow ? null : rangeHigh,
      source:
        postingsWithSalary > 1
          ? `Posted salary ranges across ${postingsWithSalary} of this company's jobs`
          : "Posted salary range on this company's job",
      confidence: 'high',
    }
  }

  const titles = jobs.map((j) => j.title ?? '').filter(Boolean)
  const baseline = baselineFromTitles(titles)
  if (baseline) return baseline

  return {
    rangeLow: null,
    rangeHigh: null,
    source: 'No public compensation data found',
    confidence: 'low',
  }
}
