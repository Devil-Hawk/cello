// Proves mojibake repair covers the path that ACTUALLY corrupted live rows.
//
// An adversarial review found the first attempt at this fix was wired into
// lib/ats/index.ts sanitizeJobs() — the Greenhouse/Lever/Ashby path, which had
// ZERO corrupted rows. All 106 corrupted rows in the live table arrived through
// a lib/sources adapter (every one source='remoteok'), so the user-visible
// symptom was untouched by that fix. These tests pin the seam that covers the
// real path, and they use the exact byte sequences from the reported posting.

import { describe, expect, it } from 'vitest'
import { stripHtml } from './util'
import { hasMojibake, repairMojibake } from '../jobs/mojibake'

// Verbatim from the job description the user reported.
const REPORTED = 'Employment Type: Full-time Contractor, Remote Working Hours: 9:00 AM â€“ 6:00 PM'
const BULLETS = 'Â· Â Â Design, build, and maintain AI Agents for business operations.'
const YEARS = '1â€“3 years of experience building AI applications'
// From the live companies table.
const COMPANY_A = 'UniversitÃ© de Bordeaux'
const COMPANY_B = 'Coâ€“Star'

describe('stripHtml repairs mojibake — the shared seam for every board adapter', () => {
  it('repairs the reported working-hours dash', () => {
    const out = stripHtml(REPORTED)
    expect(hasMojibake(out)).toBe(false)
    expect(out).not.toContain('â')
    expect(out).toMatch(/9:00 AM .{1,3} 6:00 PM/)
  })

  it('repairs the mangled bullet and non-breaking spaces', () => {
    const out = stripHtml(BULLETS)
    expect(out).not.toContain('Â·')
    expect(out).toContain('Design, build, and maintain')
  })

  it('repairs a mangled en dash between numbers', () => {
    const out = stripHtml(YEARS)
    expect(out).not.toContain('â')
    expect(out).toMatch(/1.{1,3}3 years/)
  })

  it('leaves already-correct text completely alone', () => {
    for (const clean of [
      'Senior Engineer — Platform',
      'Café culture and naïve résumé wording',
      'Salary: $120,000 – $160,000',
      'Work with Ångström Ltd.',
      'plain ascii description with no punctuation tricks',
    ]) {
      expect(stripHtml(clean)).toBe(clean)
    }
  })

  it('still strips tags and decodes entities as before', () => {
    expect(stripHtml('<p>Hello &amp; welcome</p><script>x()</script>')).toBe('Hello & welcome')
  })

  it('handles null and empty input', () => {
    expect(stripHtml(null)).toBe('')
    expect(stripHtml(undefined)).toBe('')
    expect(stripHtml('')).toBe('')
  })
})

describe('company names — the field adapters only .trim()', () => {
  it('repairs the two corrupted employer names found in the live table', () => {
    expect(repairMojibake(COMPANY_A)).toBe('Université de Bordeaux')
    expect(hasMojibake(repairMojibake(COMPANY_B))).toBe(false)
  })

  it('does not mangle employer names that are already correct', () => {
    for (const name of ['Université de Bordeaux', 'Nestlé', 'Ørsted', 'CI&T', 'Zoë Ltd']) {
      expect(repairMojibake(name)).toBe(name)
    }
  })
})
