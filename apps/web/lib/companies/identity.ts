// One identity for a company wherever a suggestion meets it: the domain, else its board, else its normalised name.

import { normalizeCompanyName } from '../entities/companies'

/** Host without scheme, path, `www.`, `jobs.` or `careers.`. Null when unusable. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let host = input.trim().toLowerCase()
  if (!host) return null
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname
    } catch {
      return null
    }
  }
  host = host.split('/')[0].split('?')[0].split('#')[0].replace(/:\d+$/, '').replace(/\.$/, '')
  host = host.replace(/^www\./, '').replace(/^(jobs|careers)\./, '')
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null
  return host
}

export function identityKey(domain: string | null | undefined, ats: { provider: string; token: string } | null | undefined, name: string): string {
  const d = normalizeDomain(domain)
  if (d) return d
  if (ats) return `ats:${ats.provider}:${ats.token}`
  return `name:${normalizeCompanyName(name)}`
}
