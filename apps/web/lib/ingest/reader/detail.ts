// What a role's own page says about it: the employer's declared JobPosting when
// there is one, else the page's title, the date a site embeds, and the text of
// its main region. Used to confirm every role a listing or a sitemap names and
// to fill in what those did not carry.

import * as cheerio from 'cheerio'
import type { AtsJob } from '../../ats/types'
import { descriptionFromPage } from '../details'
import { readJobPostings } from '../jsonld'
import { normalizeJobUrl } from '../snapshot'

export interface RoleDetail {
  title: string
  postedAt?: string
  validThrough?: string
  employer?: string
  requisitionId?: string
  description?: string
  location?: string
  isEvent?: boolean
  /** Every address the page links to, for finding the applicant system behind a posting. */
  hrefs: string[]
}

/** Dates sites embed in a page without a JobPosting block (Apple postDateInGMT, Walmart createdAt, generic datePosted). */
const EMBEDDED_DATE = /\\?"(?:postDateInGMT|datePosted|postingDate|postedDate|createdAt|jobPostingStartDate)\\?"\s*:\s*\\?"([^"\\]{8,40})\\?"/i

function isoOf(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

function clean(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/** The page's own name for the role, minus the site's suffix ("... - Jobs - Careers at Apple"). */
export function pageTitle($: cheerio.CheerioAPI): string {
  const og = clean($('meta[property="og:title"]').attr('content'))
  const h1 = clean($('h1').first().text())
  const title = clean($('title').first().text())
  // A generic h1 ("job details") is not the role.
  const candidate = og || (h1.split(/\s+/).length >= 2 && !/^job details$/i.test(h1) ? h1 : '') || title
  // "Role - Jobs - Careers at Apple", "Role | Datadog Careers": the site's own name after the role is not part of it.
  return candidate.replace(/(?:\s+[-|—–]\s+[^-|—–]*\b(?:careers?|jobs)\b[^-|—–]*)+$/i, '').trim()
}

/**
 * Read one role's page. `url` is where it was fetched from. Never throws.
 */
export function readDetail(html: string, url: string): RoleDetail {
  const hrefs: string[] = []
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return { title: '', hrefs }
  }
  $('a[href]').each((_, el) => {
    if (hrefs.length >= 400) return
    try {
      hrefs.push(new URL($(el).attr('href') ?? '', url).toString())
    } catch {
      /* not a url */
    }
  })

  const declared = readJobPostings(html, url)[0]
  if (declared) {
    return {
      title: declared.title,
      postedAt: declared.postedAt,
      validThrough: declared.validThrough,
      employer: declared.employer,
      requisitionId: declared.requisitionId,
      description: declared.description,
      location: declared.location,
      isEvent: declared.isEvent,
      hrefs,
    }
  }

  const title = pageTitle($)
  const embedded = EMBEDDED_DATE.exec(html)?.[1]
  const posted = isoOf(embedded) ?? isoOf($('meta[property="article:published_time"]').attr('content')) ?? isoOf($('time[datetime]').first().attr('datetime'))
  return {
    title,
    postedAt: posted,
    description: title ? descriptionFromPage(html, url, title) : undefined,
    hrefs,
  }
}

/** A role built from what its own page says, or null when the page does not name `expectedTitle` (a redirect to somewhere generic). */
export function jobFromDetail(url: string, detail: RoleDetail, expected?: { title?: string; location?: string; postedAt?: string }): AtsJob | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const title = detail.title || expected?.title || ''
  if (!title) return null
  if (expected?.title && detail.title && !norm(detail.title).includes(norm(expected.title)) && !norm(expected.title).includes(norm(detail.title))) return null
  return {
    title: expected?.title && norm(detail.title).includes(norm(expected.title)) ? expected.title : title,
    url,
    externalId: normalizeJobUrl(url),
    ...((detail.location ?? expected?.location) ? { location: detail.location ?? expected?.location } : {}),
    ...((detail.postedAt ?? expected?.postedAt) ? { postedAt: detail.postedAt ?? expected?.postedAt } : {}),
    ...(detail.validThrough ? { validThrough: detail.validThrough } : {}),
    ...(detail.employer ? { employer: detail.employer } : {}),
    ...(detail.requisitionId ? { requisitionId: detail.requisitionId } : {}),
    ...(detail.description ? { description: detail.description } : {}),
    ...(detail.isEvent ? { isEvent: true } : {}),
  }
}
