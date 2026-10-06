// What a role's own page says about it: the employer's declared JobPosting when
// there is one, else the page's title, the date a site embeds, and the text of
// its main region. Used to confirm every role a listing or a sitemap names and
// to fill in what those did not carry.

import * as cheerio from 'cheerio'
import type { AtsJob } from '../../ats/types'
import { bodyFromPage } from '../details'
import { readJobPostings } from '../jsonld'
import { normalizeJobUrl } from '../snapshot'
import { htmlToPlainText } from '../../ats/html'
import { readEmbeddedPosting } from './embedded'

export interface RoleDetail {
  title: string
  postedAt?: string
  validThrough?: string
  employer?: string
  requisitionId?: string
  description?: string
  /** The employer's HTML for the posting, and which way it was read, for the Markdown copy. */
  descriptionHtml?: string
  descriptionSource?: 'jsonld' | 'detail'
  location?: string
  isEvent?: boolean
  /** Job language in the page's text (responsibilities, qualifications, "you will"), whether or not the page names its role. */
  jobTerms?: number
  /** The page carries a schema.org JobPosting: the employer's own statement that it is one. */
  declared?: boolean
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
  return candidate.replace(/(?:\s+[-|\u2014\u2013]\s+[^-|\u2014\u2013]*\b(?:careers?|jobs)\b[^-|\u2014\u2013]*)+$/i, '').trim()
}

/**
 * Read one role's page. `url` is where it was fetched from. Never throws.
 */
export function readDetail(html: string, url: string): RoleDetail {
  const d = readDetailBase(html, url)
  // A page that carries its posting as embedded data (Apple) gives what the markup left empty.
  const emb = d.employer ? null : readEmbeddedPosting(html, d.title || undefined)
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!emb || (d.title && !(norm(d.title).includes(norm(emb.title)) || norm(emb.title).includes(norm(d.title))))) return d
  return {
    ...d,
    title: d.title || emb.title,
    location: d.location ?? emb.location,
    // Structured data beats the text of a rendered region, which may be a menu.
    description: emb.description ?? d.description,
    ...(emb.descriptionHtml ? { descriptionHtml: emb.descriptionHtml, descriptionSource: 'detail' as const } : {}),
    postedAt: d.postedAt ?? emb.postedAt,
  }
}

function readDetailBase(html: string, url: string): RoleDetail {
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
      descriptionHtml: declared.descriptionHtml,
      ...(declared.descriptionHtml ? { descriptionSource: 'jsonld' as const } : {}),
      location: declared.location,
      isEvent: declared.isEvent,
      declared: true,
      hrefs,
    }
  }

  const { terms, place: textPlace, labelled } = jobTermsAndPlace(html)
  const place = textPlace ?? pagePlace($)
  const title = pageTitle($)
  const body = title ? bodyFromPage(html, url, title) : undefined
  const embedded = EMBEDDED_DATE.exec(html)?.[1]
  const posted = isoOf(embedded) ?? isoOf($('meta[property="article:published_time"]').attr('content')) ?? isoOf($('time[datetime]').first().attr('datetime')) ?? labelled.postedAt
  return {
    title,
    postedAt: posted,
    ...(labelled.validThrough ? { validThrough: labelled.validThrough } : {}),
    ...(place ?? labelled.place ? { location: place ?? labelled.place } : {}),
    ...(labelled.requisitionId ? { requisitionId: labelled.requisitionId } : {}),
    jobTerms: terms,
    description: body?.text,
    ...(body ? { descriptionHtml: body.html, descriptionSource: body.source } : {}),
    hrefs,
  }
}

/** Material icon names a page puts before its place. */
const PLACE_ICON = /^(?:place|location_on|location_pin|pin_drop)$/

/**
 * A place the page marks up rather than labels in its text: a site's location icon (Amazon: an element with aria-label="location"
 * beside its list; Google: a place icon beside the text) or, on a page that shows its list beside the role, the card of the role being read (aria-current="page"; Google).
 */
function pagePlace($: cheerio.CheerioAPI): string | undefined {
  // A location icon (Google's role page: <i aria-hidden="true">place</i><span>Sunnyvale, CA, USA</span>) is followed by the role's own place.
  const pin = $('[aria-hidden="true"]')
    .filter((_, el) => PLACE_ICON.test(clean($(el).text())))
    .first()
  const beside = clean(pin.next().text())
  if (beside && beside.length <= 120) return beside
  const icon = clean($('[aria-label="location"]').first().parent().find('li').first().text())
  if (icon) return icon
  const cardLine = $('a[aria-current="page"] p').first()
  const card = clean(cardLine.find('span span').first().text()) || clean(cardLine.text())
  return card || undefined
}

/** What a posting says and a department, category or landing page does not (a footer's "equal opportunity" or a menu's "apply" is not here). */
const JOB_TERMS = [
  /\bresponsibilit(?:y|ies)\b/i,
  /\b(?:minimum |basic |preferred )?qualifications?\b/i,
  /\bjob description\b/i,
  /\bwhat you(?:'|\u2019)ll (?:do|bring|need)\b/i,
  /\byou will\b|\byou(?:'|\u2019)ll (?:be|work|own|build|lead)\b/i,
  /\babout the (?:role|job|position)\b/i,
  /\byears of (?:relevant |professional )?experience\b/i,
]
/** A place a page labels as one ("Office: New York, NY"). */
const LABELLED_PLACE = /\b(?:office|job location|work location|locations?)\s*:\s*([^\n:]{2,80}?)\s*(?:\n|$|\s(?:department|team|job id|req|category|employment)\b)/i

/**
 * Facts a page lists as label, then value on the next line (a definition list: "Date posted", "Reference number", "Job locations").
 * Only labels that name one fact: a bare "Locations" heading is a menu as often as a place.
 */
// The value's line is group 1; the line after it, when there is one, is group 2.
const LABEL_THEN_VALUE = (label: string) => new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*:?[ \\t]*\\n+\\s*([^\\n]{2,80})(?:\\n+[ \\t]*([^\\n]{2,60}))?`, 'i')
const POSTED_LABEL = LABEL_THEN_VALUE('date posted|posted on|publication date|date published|posting (?:begin|start)(?:/end)? date|posting date|posted date')
const REQ_LABEL = LABEL_THEN_VALUE('reference number|job reference|reference|requisition(?: id| number)?|job (?:opening )?(?:id|number)|req(?:uisition)? id')
const PLACE_LABEL = LABEL_THEN_VALUE('job locations?|work locations?')
/** The second line of a place ("Ann Arbor Campus", then "Ann Arbor, MI"): a city and a two-letter state, case-sensitive. */
const CITY_STATE = /^[A-Z][\w .'-]{1,40}, [A-Z]{2}$/
/** "9/13/2026 - 10/13/2026", "Sep 13, 2026 to Oct 13, 2026": spaces around the separator, so an ISO date is not split. */
const DATE_RANGE = /\s+(?:-|\u2013|\u2014|to)\s+/

function jobTermsAndPlace(html: string): { terms: number; place?: string; labelled: { postedAt?: string; validThrough?: string; requisitionId?: string; place?: string } } {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return { terms: 0, labelled: {} }
  }
  $('script,style,noscript,svg,iframe,template,nav,header,footer,form').remove()
  // A sidebar is where many sites keep a role's fact panel (UMich: Job Opening ID, Work Location, Posting Begin/End Date): its labelled
  // facts are read, after the main text's own. It is not job language or a "Location:" line, which a menu would also supply.
  const asideText = $('aside').toArray().map((el) => htmlToPlainText($.html(el), 50_000) ?? '').join('\n')
  $('aside').remove()
  const text = htmlToPlainText($('body').html() ?? '', 200_000) ?? ''
  const facts = `${text}\n${asideText}`
  const req = REQ_LABEL.exec(facts)?.[1]?.trim()
  const [from, to] = (POSTED_LABEL.exec(facts)?.[1]?.trim() ?? '').split(DATE_RANGE)
  const place = PLACE_LABEL.exec(facts)
  const next = place?.[2]?.trim()
  const dateOf = (v: string | undefined) => (v && /\d{4}/.test(v) ? isoOf(`${v} UTC`) : undefined)
  const end = dateOf(to)
  return {
    terms: JOB_TERMS.filter((re) => re.test(text)).length,
    place: LABELLED_PLACE.exec(text)?.[1]?.trim(),
    labelled: {
      postedAt: dateOf(from),
      // A posting window's end is the last day it is open: kept to the end of that day.
      validThrough: end ? new Date(Date.parse(end) + 86_399_000).toISOString() : undefined,
      requisitionId: req && /\d/.test(req) && /^[\w./-]{3,40}$/.test(req) ? req : undefined,
      place: place?.[1] ? (next && CITY_STATE.test(next) ? `${place[1].trim()} / ${next}` : place[1].trim()) : undefined,
    },
  }
}

/**
 * Is this page a posting and not merely a page that shares a title with a link? A declared
 * JobPosting is proof; otherwise at least two of: a place, a date, a requisition id, and a
 * description in job language. (The card a link sat in may supply the place or the date.)
 */
export function isPostingPage(detail: RoleDetail, card?: { location?: string; postedAt?: string }, signs = 2): boolean {
  if (detail.declared) return true
  const evidence = [
    detail.location ?? card?.location,
    detail.postedAt ?? card?.postedAt,
    detail.requisitionId,
    // Two different job terms: a department page that says "responsibilities" once is not a posting.
    (detail.jobTerms ?? 0) >= 2 ? 'language' : undefined,
  ].filter(Boolean)
  return evidence.length >= signs
}

/** A role built from what its own page says, or null when the page does not name `expectedTitle` (a redirect to somewhere generic). */
export function jobFromDetail(
  url: string,
  detail: RoleDetail,
  expected?: { title?: string; location?: string; postedAt?: string },
  opts: { requirePosting?: boolean; /** Signs of a posting a page must show (default 2); a link a person pasted as one needs 1. */ signs?: number } = {}
): AtsJob | null {
  if (opts.requirePosting && !isPostingPage(detail, expected, opts.signs)) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  // A role is confirmed by its own page: a page with no title of its own (a script shell) confirms nothing, so the card's title alone never makes a role.
  if (expected?.title && !detail.title) return null
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
    ...(detail.descriptionHtml ? { descriptionHtml: detail.descriptionHtml, descriptionSource: detail.descriptionSource ?? 'detail' } : {}),
    ...(detail.isEvent ? { isEvent: true } : {}),
  }
}
