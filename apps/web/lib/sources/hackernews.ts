// Hacker News "Ask HN: Who is hiring?" via the public Algolia API.
// https://hn.algolia.com/api  — public, keyless, JSON. We locate the latest
// monthly thread (author `whoishiring`) then read its TOP-LEVEL comments (each
// is one employer posting) and heuristically parse "Company | Role | Location".
// Freeform text is messy, so we only keep postings that carry an apply URL.

import type { JobLead, SourceAdapter, SourceQuery } from './types'
import {
  employerDomainFromUrl,
  firstUrlIn,
  getJson,
  rankAndLimit,
  sanitizeLeads,
  stripHtml,
  truncate,
} from './util'

const HOSTS = new Set(['hn.algolia.com'])
const COMMENT_PAGES = 2
const HITS_PER_PAGE = 100

interface AlgoliaStoryHit {
  objectID: string
  title?: string
  num_comments?: number
}
interface AlgoliaCommentHit {
  objectID: string
  parent_id?: number | string
  story_id?: number | string
  comment_text?: string
}
interface AlgoliaResponse<T> {
  hits?: T[]
  nbHits?: number
}

const REMOTE_WORDS = /^(remote|onsite|on-site|hybrid|full-?time|part-?time|contract|intern)/i

async function findLatestThreadId(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  const url =
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring' +
    '&restrictSearchableAttributes=title&query=' +
    encodeURIComponent('Ask HN: Who is hiring?') +
    '&hitsPerPage=5'
  let res: AlgoliaResponse<AlgoliaStoryHit>
  try {
    res = await getJson<AlgoliaResponse<AlgoliaStoryHit>>(url, HOSTS)
  } catch {
    return null
  }
  const hit = (res.hits ?? []).find((h) => /who is hiring/i.test(h.title ?? ''))
  return hit?.objectID ?? res.hits?.[0]?.objectID ?? null
}

function parsePosting(comment: AlgoliaCommentHit): JobLead | null {
  const text = stripHtml(comment.comment_text)
  if (!text) return null
  const applyUrl = firstUrlIn(text)
  if (!applyUrl) return null // no apply link → too noisy to trust

  // The header line is typically "Company | Role | Location | remote | ...".
  const header = text.split(/[\n\r]|(?:\s{2,})/)[0] || text.slice(0, 200)
  const parts = header
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)

  const company = (parts[0] || '').slice(0, 80).trim()
  if (!company || company.length < 2 || /https?:/i.test(company)) return null

  // Pick the first non-company, non-modifier segment as the role title.
  const title =
    parts.slice(1).find((p) => p.length >= 2 && !REMOTE_WORDS.test(p))?.slice(0, 120) ||
    'Open role'
  // A segment that reads like a location (has a comma or a remote keyword).
  const location =
    parts.slice(1).find((p) => /,|remote|hybrid|onsite/i.test(p))?.slice(0, 80) || null

  const permalink = `https://news.ycombinator.com/item?id=${comment.objectID}`
  return {
    company,
    title,
    url: applyUrl,
    location,
    salary: null,
    description: truncate(text, 2000),
    source: 'hackernews',
    externalId: permalink, // one stable id per HN comment
    companyDomain: employerDomainFromUrl(applyUrl),
    postedAt: null,
    tags: [],
  }
}

export const hackernews: SourceAdapter = {
  id: 'hackernews',
  label: 'HN Who is hiring',
  async fetchLeads(q: SourceQuery): Promise<JobLead[]> {
    const storyId = await findLatestThreadId(q.signal)
    if (!storyId) return []

    const leads: JobLead[] = []
    for (let page = 0; page < COMMENT_PAGES; page++) {
      if (q.signal?.aborted) break
      const url =
        `https://hn.algolia.com/api/v1/search?tags=comment,story_${storyId}` +
        `&hitsPerPage=${HITS_PER_PAGE}&page=${page}`
      let res: AlgoliaResponse<AlgoliaCommentHit>
      try {
        res = await getJson<AlgoliaResponse<AlgoliaCommentHit>>(url, HOSTS)
      } catch {
        break
      }
      const hits = res.hits ?? []
      for (const c of hits) {
        // Only top-level comments (direct children of the story) are postings.
        if (String(c.parent_id) !== String(storyId)) continue
        const lead = parsePosting(c)
        if (lead) leads.push(lead)
      }
      if (hits.length < HITS_PER_PAGE) break
    }
    return rankAndLimit(sanitizeLeads(leads, q.targeting), q)
  },
}
