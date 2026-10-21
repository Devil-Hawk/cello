// Rung 5 of the search by name: the web, through the search provider the project already chose (Tavily, lib/search).
//
// The query is "<name> careers". Job sites, applicant systems and pages about a company rather than by it are dropped,
// and the first three registrable domains are what is left. Only the Tavily backend is asked: a search that fell through
// the chain to the keyless scrape would be scraping a search engine from the app, which only the pull worker may do.
// No key (or a failed search) is null, and the caller queues the search for the worker instead.

import { repostHostOf } from '../ingest/reader/legit'
import { webSearch } from '../search'
import { PROVIDER_HOSTS } from './verify-directory'
import { registrable } from './wikidata'

/** Pages about an employer, or by a person, not the employer's own site. */
const ABOUT_HOSTS = /(^|\.)(wikipedia\.org|crunchbase\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|reddit\.com|medium\.com|github\.com|g2\.com|tiktok\.com)$/

export const MAX_WEB_DOMAINS = 3

export async function searchCareersDomains(name: string, tavilyKey: string | undefined, search: typeof webSearch = webSearch): Promise<string[] | null> {
  if (!tavilyKey) return null
  const found = await search(`${name} careers`, { backend: 'tavily', tavilyKey, limit: 10 })
  if (!found.ok) return null
  const domains: string[] = []
  for (const { url } of found.results) {
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase()
      } catch {
        return ''
      }
    })()
    const domain = host ? registrable(host) : null
    if (!domain || repostHostOf(url) || PROVIDER_HOSTS.test(host) || ABOUT_HOSTS.test(host) || domains.includes(domain)) continue
    domains.push(domain)
    if (domains.length === MAX_WEB_DOMAINS) break
  }
  return domains
}
