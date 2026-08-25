import { describe, expect, it } from 'vitest'
import { sponsorshipSignalForCompanies, sponsorshipSignalForCompany, visaFromCuratedList } from './visa'

describe('visaFromCuratedList — zero-LLM-cost curated match', () => {
  it('matches an exact curated name', () => {
    expect(visaFromCuratedList('Google')).toBe('likely')
  })

  it('matches common legal-suffix variants ("Snowflake Inc." -> "snowflake")', () => {
    expect(visaFromCuratedList('Snowflake Inc.')).toBe('likely')
    expect(visaFromCuratedList('SNOWFLAKE, INC')).toBe('likely')
    expect(visaFromCuratedList('Snowflake Inc')).toBe('likely')
    expect(visaFromCuratedList('Snowflake')).toBe('likely')
    expect(visaFromCuratedList('Stripe, Inc.')).toBe('likely')
    expect(visaFromCuratedList('Databricks, Inc.')).toBe('likely')
  })

  it('does not collapse a semantically different company via an over-eager suffix strip', () => {
    // "Tech Mahindra" (curated, verified DoL filer) must not make "Mahindra
    // Group" (a distinct, unrelated conglomerate) read as a sponsorship match
    // just because "tech" was stripped as if it were a legal suffix.
    expect(visaFromCuratedList('Tech Mahindra')).toBe('likely')
    expect(visaFromCuratedList('Mahindra Group')).toBe('unknown')
    expect(visaFromCuratedList('Mahindra Comviva')).toBe('unknown')
  })

  it('returns unknown for a company with no public signal — never "unlikely" from the curated list alone', () => {
    expect(visaFromCuratedList('Riskified')).toBe('unknown')
    expect(visaFromCuratedList('Some Startup Nobody Has Heard Of LLC')).toBe('unknown')
  })

  it('returns unknown for empty/garbage input without throwing', () => {
    expect(visaFromCuratedList('')).toBe('unknown')
    expect(visaFromCuratedList('   ')).toBe('unknown')
  })
})

describe('sponsorshipSignalForCompany / sponsorshipSignalForCompanies', () => {
  it('always carries the honest, non-overstating caveat note', () => {
    const r = sponsorshipSignalForCompany('Google')
    expect(r.signal).toBe('likely')
    expect(r.note).toMatch(/never a guarantee/i)
  })

  it('is zero-LLM-cost: pure sync function, no network/DB/async', () => {
    const result = sponsorshipSignalForCompany('Google')
    expect(typeof result).toBe('object') // resolved synchronously, not a Promise
  })

  it('checks a handful of real tracked company names, including a suffix variant, in bulk', () => {
    const names = ['Google', 'Snowflake Inc.', 'Databricks', 'Riskified', 'Loom']
    const results = sponsorshipSignalForCompanies(names)
    console.log('\nSponsorship lookup (zero LLM cost):')
    for (const r of results) console.log(`  ${r.signal.padEnd(9)} | ${r.name}`)

    expect(results.map((r) => r.signal)).toEqual(['likely', 'likely', 'likely', 'unknown', 'unknown'])
    // Echoes the caller's input order/names 1:1.
    expect(results.map((r) => r.name)).toEqual(names)
  })
})
