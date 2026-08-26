// Deriving a company's own domain from its job URLs — used by
// scripts/backfill-company-identity.ts. Pulled out of the script itself
// (rather than left inline) so it can be unit-tested: owner-run scripts in
// this codebase self-invoke main() at module load (see
// scripts/backfill-embeddings.ts), so importing the script itself into a
// test would try to run it for real.

import { employerDomainFromUrl, SOURCE_FETCH_HOSTS } from '../sources/util'

/**
 * A domain derived from a company's own job URLs must never be an aggregator
 * host. employerDomainFromUrl (lib/sources/util.ts) already refuses to
 * return one by construction — this is defense in depth on top of that: a
 * poisoned domain written to companies.domain doesn't just mislabel one
 * field, it feeds scanMergeCandidates' same-domain AUTO-merge, which is
 * exactly the mechanism that turned the historical mojibake-era incident
 * (190 of one user's 436 companies carrying an aggregator domain — see
 * SOURCE_FETCH_HOSTS's comment) into wrong entity fusion instead of a
 * cosmetic bad field.
 */
export function assertNotAggregatorHost(domain: string): void {
  const bare = domain.toLowerCase().replace(/^www\./, '')
  const isAggregator = (SOURCE_FETCH_HOSTS as readonly string[]).some((h) => bare === h || bare.endsWith(`.${h}`))
  if (isAggregator) {
    throw new Error(
      `assertNotAggregatorHost: employerDomainFromUrl returned an aggregator host "${domain}" — ` +
        'this must never happen (SOURCE_FETCH_HOSTS exclusion regressed).'
    )
  }
}

/** First employer domain (never an aggregator's — see assertNotAggregatorHost) found across a company's own job URLs. */
export function deriveCompanyDomain(jobUrls: (string | null)[]): string | null {
  for (const url of jobUrls) {
    const domain = employerDomainFromUrl(url)
    if (domain) {
      assertNotAggregatorHost(domain)
      return domain
    }
  }
  return null
}
