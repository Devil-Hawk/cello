// A careers page, reduced to what a model may be asked about and what a model's
// answer can be checked against.
//
// The model is never asked to write a URL. It sees numbered links and points at
// one; the URL that gets stored is the page's own href. A job survives only if
// its title is on the page, its link number exists and goes somewhere that can
// hold a posting. That is the whole defence against a model that "remembers"
// what a company hires for instead of reading the page.

import * as cheerio from 'cheerio'
import type { AtsJob } from '../ats/types'

export interface PageLink {
  label: string
  href: string
  /** The text of the card the link sits in: the widest ancestor holding no other posting's link. Not shown to the model. */
  context: string
}

export interface PageSnapshot {
  text: string
  /** Numbered from 1 in the prompt: link n is links[n - 1]. */
  links: PageLink[]
  /** True when the page had more text or links than were kept. */
  truncated: boolean
  /** The page's own URL, after redirects. */
  url: string
}

export const MAX_SNAPSHOT_CHARS = 30_000
export const MAX_SNAPSHOT_LINKS = 300

/** Hosts that hold job postings for many employers; a link to one is a plausible posting URL. */
export const KNOWN_JOB_HOSTS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'myworkdaysite.com',
  'smartrecruiters.com',
  'workable.com',
  'recruitee.com',
  'personio.de',
  'personio.com',
  'teamtailor.com',
  'bamboohr.com',
  'jobvite.com',
  'icims.com',
  'breezy.hr',
  'rippling.com',
  'workforcenow.adp.com',
  'taleo.net',
  'successfactors.com',
  'oraclecloud.com',
  'dayforcehcm.com',
  'paylocity.com',
  'ultipro.com',
  'applytojob.com',
  'pinpointhq.com',
  'join.com',
] as const

const TRACKING_PARAM = /^(?:utm_.*|gh_src|gh_jid_src|source|ref|referrer|src|fbclid|gclid|mc_.*)$/i

/** One id for one posting, whatever tracking the link carried. Returns the input unchanged when it is not a URL. */
export function normalizeJobUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  u.hash = ''
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key)
  let out = u.toString()
  if (u.pathname.length > 1 && out.endsWith('/') && !u.search) out = out.slice(0, -1)
  return out
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const GENERIC_LABEL =
  /^(?:apply(?: now| here| today)?|view(?: this)?(?: job| role| position| posting| details)?|learn more|read more|see (?:role|job|position|details)|details|more info|more details|open role|open position|job details)$/i

/**
 * Cheerio text with block boundaries kept as line breaks, so a card's title and
 * its Apply link stay on neighbouring lines instead of fusing into one.
 */
function blockText($: cheerio.CheerioAPI): string {
  const body = $('body').length ? $('body') : $.root()
  body.find('br').replaceWith('\n')
  body.find('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,header,footer,ul,ol,table,dd,dt').each((_, el) => {
    $(el).append('\n')
  })
  return body
    .text()
    .split('\n')
    .map(squash)
    .filter(Boolean)
    .join('\n')
}

const MAX_CARD_CHARS = 400

/**
 * The card a link belongs to: climb while the parent holds no link to a
 * different address and is still short. A title three paragraphs away from an
 * Apply link is not that link's title.
 */
function cardText($: cheerio.CheerioAPI, el: cheerio.Element, pageUrl: string): string {
  const own = hrefId(($(el).attr('href') ?? ''), pageUrl)
  let node = $(el)
  for (;;) {
    const parent = node.parent()
    if (!parent.length || /^(?:body|html)$/i.test(parent.prop('tagName') ?? '') || parent.is('main')) break
    const others = parent
      .find('a[href]')
      .toArray()
      .some((a) => hrefId($(a).attr('href') ?? '', pageUrl) !== own)
    if (others || squash(parent.text()).length > MAX_CARD_CHARS) break
    node = parent
  }
  return squash(node.text()).slice(0, MAX_CARD_CHARS)
}

function hrefId(raw: string, pageUrl: string): string {
  try {
    return normalizeJobUrl(new URL(raw.trim(), pageUrl).toString())
  } catch {
    return raw
  }
}

/** Reduce a page to numbered links and text. Never throws. */
export function snapshotPage(html: string, url: string): PageSnapshot {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return { text: '', links: [], truncated: false, url }
  }
  $('script,style,noscript,svg,iframe,template').remove()

  const links: PageLink[] = []
  const seen = new Set<string>()
  let truncated = false
  $('a[href]').each((_, el) => {
    const raw = ($(el).attr('href') ?? '').trim()
    if (!raw || raw.startsWith('#') || /^(?:javascript|tel):/i.test(raw)) return
    let abs: string
    try {
      abs = new URL(raw, url).toString()
    } catch {
      return
    }
    const label = squash($(el).text()) || squash($(el).attr('aria-label') ?? '') || squash($(el).attr('title') ?? '')
    const key = `${normalizeJobUrl(abs)}\u0000${label}`
    if (seen.has(key)) return
    seen.add(key)
    if (links.length >= MAX_SNAPSHOT_LINKS) {
      truncated = true
      return
    }
    links.push({ label: label.slice(0, 160), href: abs, context: cardText($, el, url) })
  })

  let text = blockText($)
  if (text.length > MAX_SNAPSHOT_CHARS) {
    text = text.slice(0, MAX_SNAPSHOT_CHARS)
    truncated = true
  }
  return { text, links, truncated, url }
}

/** What the model returned, parsed. link is the 1-based number from the prompt. */
export interface ModelJob {
  title: string
  link: number | null
  location?: string | null
}
export interface ModelPageAnswer {
  page_kind: 'listing' | 'single_posting' | 'no_postings' | 'not_a_jobs_page'
  jobs: ModelJob[]
}

const normText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/** Last two labels (three for co.uk style): enough to tell a company's site from another one. */
function siteOf(host: string): string {
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const tail2 = parts.slice(-2).join('.')
  if (/^(?:co|com|org|net|gov|ac)\.[a-z]{2}$/.test(tail2)) return parts.slice(-3).join('.')
  return tail2
}

function sameSiteOrJobHost(href: URL, page: URL): boolean {
  const host = href.hostname.toLowerCase()
  if (siteOf(host) === siteOf(page.hostname.toLowerCase())) return true
  return KNOWN_JOB_HOSTS.some((h) => hostMatches(host, h))
}

export interface Verified {
  kept: AtsJob[]
  /** Items the model returned that the page did not back up. */
  dropped: number
}

/**
 * Keep the jobs on `snap` the model named, and count the rest. An item stays
 * only if all of these hold:
 *   - its link number exists in the snapshot;
 *   - the href is http(s), is not the page itself, and is on the page's own site or a known job host;
 *   - its title is in that link's label, or the label is a generic action ("Apply") and the title is in that link's own card.
 * The stored URL is the href the page carries, never text the model wrote.
 */
export function verifyModelJobs(answer: ModelPageAnswer, snap: PageSnapshot): Verified {
  const pageUrl = new URL(snap.url)
  const self = normalizeJobUrl(snap.url)
  const textNorm = normText(snap.text)
  const kept: AtsJob[] = []
  const used = new Set<string>()
  let dropped = 0

  for (const item of answer.jobs) {
    const title = typeof item?.title === 'string' ? squash(item.title) : ''
    const n = item?.link
    if (!title || title.length > 200 || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > snap.links.length) {
      dropped++
      continue
    }
    const link = snap.links[n - 1]
    let href: URL
    try {
      href = new URL(link.href)
    } catch {
      dropped++
      continue
    }
    if (href.protocol !== 'https:' && href.protocol !== 'http:') {
      dropped++
      continue
    }
    const id = normalizeJobUrl(href.toString())
    if (id === self || used.has(id) || !sameSiteOrJobHost(href, pageUrl)) {
      dropped++
      continue
    }
    const t = normText(title)
    const label = normText(link.label)
    const titleInLabel = t.length > 0 && label.includes(t)
    const genericLabel = GENERIC_LABEL.test(link.label.trim()) || label === ''
    const titleInCard = t.length > 0 && normText(link.context).includes(t)
    if (!(titleInLabel || (genericLabel && titleInCard))) {
      dropped++
      continue
    }
    used.add(id)
    const location = typeof item.location === 'string' ? squash(item.location) : ''
    kept.push({
      title,
      url: href.toString(),
      externalId: id,
      ...(location && textNorm.includes(normText(location)) ? { location } : {}),
    })
  }
  return { kept, dropped }
}
