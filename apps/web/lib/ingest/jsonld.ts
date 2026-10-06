// Job postings an employer declares in its own page markup (schema.org
// JobPosting in a <script type="application/ld+json"> tag). It is the
// employer's statement, not our reading of the page, so it needs no model and
// no verification, and it is tried before anything else.

import * as cheerio from 'cheerio'
import type { AtsJob } from '../ats/types'
import { htmlToPlainText } from '../ats/html'
import { normalizeJobUrl } from './snapshot'

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function typesOf(node: Json): string[] {
  const t = node['@type']
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string')
}

/** Every JobPosting node in a parsed JSON-LD value: arrays, @graph and nested lists included. */
function collect(value: unknown, out: Json[], depth = 0): void {
  if (depth > 6) return
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1)
    return
  }
  if (!isObject(value)) return
  if (typesOf(value).some((t) => t === 'JobPosting' || t.endsWith('/JobPosting'))) out.push(value)
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasPart']) {
    if (key in value) collect(value[key], out, depth + 1)
  }
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (isObject(v) && typeof v.name === 'string') return v.name.trim()
  return ''
}

function placeOf(loc: unknown): string {
  if (!isObject(loc)) return str(loc)
  const a = loc.address
  if (isObject(a)) {
    const parts = [str(a.addressLocality), str(a.addressRegion), str(a.addressCountry)].filter(Boolean)
    if (parts.length) return parts.join(', ')
  }
  return str(a) || str(loc.name)
}

function locationOf(node: Json): string | undefined {
  const raw = node.jobLocation
  const places = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(placeOf).filter(Boolean)
  const unique = [...new Set(places)]
  const remote = String(node.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE'
  if (remote) unique.push('Remote')
  return unique.length ? unique.join(' · ') : undefined
}

const PERIOD: Record<string, string> = { YEAR: 'yr', MONTH: 'mo', HOUR: 'hr', WEEK: 'wk', DAY: 'day' }

function salaryOf(node: Json): string | undefined {
  const base = node.baseSalary
  if (!isObject(base)) return undefined
  const currency = typeof base.currency === 'string' ? base.currency.toUpperCase() : ''
  const v = base.value
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() && !Number.isNaN(Number(x)) ? Number(x) : null)
  let min: number | null = null
  let max: number | null = null
  let unit = ''
  if (isObject(v)) {
    min = num(v.minValue) ?? num(v.value)
    max = num(v.maxValue) ?? min
    unit = typeof v.unitText === 'string' ? v.unitText.toUpperCase() : ''
  } else {
    min = max = num(v)
  }
  if (min === null || max === null || !currency || min <= 0) return undefined
  const fmt = (n: number) => n.toLocaleString('en-US')
  const range = min === max ? fmt(min) : `${fmt(Math.min(min, max))}-${fmt(Math.max(min, max))}`
  return `${currency} ${range}${PERIOD[unit] ? ` / ${PERIOD[unit]}` : ''}`
}

function descriptionOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  // Some sites escape the markup once more, so the tags arrive as &lt;p&gt;.
  const html = !raw.includes('<') && /&lt;\w/.test(raw) ? cheerio.load(`<i>${raw}</i>`)('i').text() : raw
  return htmlToPlainText(html)
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80)
}

/** The employer's own requisition id: identifier as a string, a number, or a PropertyValue's value. */
function identifierOf(node: Json): string | undefined {
  const raw = node.identifier
  const first = Array.isArray(raw) ? raw[0] : raw
  const value = isObject(first) ? first.value : first
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined
}

/** True when the markup is about an event, not a role (a career fair posted as a JobPosting). */
function isEventNode(node: Json): boolean {
  return /\b(career fair|webinar|info(?:rmation)? session|hackathon|meetup)\b/i.test(str(node.title) || str(node.name))
}

function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

/** JSON.parse, and on failure once more with raw line breaks and tabs inside strings escaped (Kaiser Permanente's posting data has them; strict JSON does not allow them). */
function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (first) {
    let out = ''
    let inString = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inString && c === '\\') out += c + (text[++i] ?? '')
      else if (c === '"') {
        inString = !inString
        out += c
      } else if (inString && c < ' ') out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : ' '
      else out += c
    }
    try {
      return JSON.parse(out)
    } catch {
      throw first
    }
  }
}

/**
 * The postings a page declares. A posting without its own url gets the page's
 * URL with a fragment from its title, so two of them stay two jobs instead of
 * collapsing onto the page (a lone one keeps the page URL itself). A script tag
 * that is not valid JSON is skipped without losing the others.
 */
export function readJobPostings(html: string, pageUrl: string): AtsJob[] {
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return []
  }
  const nodes: Json[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collect(parseLoose($(el).contents().text().trim()) as Json, nodes)
    } catch {
      /* one bad block must not hide the others */
    }
  })

  const jobs: AtsJob[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    const title = str(node.title) || str(node.name)
    if (!title) continue
    let url = ''
    const rawUrl = str(node.url)
    if (rawUrl) {
      try {
        url = new URL(rawUrl, pageUrl).toString()
      } catch {
        url = ''
      }
    }
    let externalId: string
    if (url) {
      externalId = normalizeJobUrl(url)
    } else if (nodes.length === 1) {
      url = pageUrl
      externalId = normalizeJobUrl(pageUrl)
    } else {
      url = externalId = `${normalizeJobUrl(pageUrl)}#${slug(`${title} ${locationOf(node) ?? ''}`)}`
    }
    if (seen.has(externalId)) continue
    seen.add(externalId)
    const location = locationOf(node)
    const description = descriptionOf(node.description)
    const salary = salaryOf(node)
    const postedAt = isoDate(node.datePosted)
    const validThrough = isoDate(node.validThrough)
    const employer = str(node.hiringOrganization)
    const requisitionId = identifierOf(node)
    jobs.push({
      title,
      url,
      externalId,
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(salary ? { salary } : {}),
      ...(postedAt ? { postedAt } : {}),
      ...(validThrough ? { validThrough } : {}),
      ...(employer ? { employer } : {}),
      ...(requisitionId ? { requisitionId } : {}),
      ...(isEventNode(node) ? { isEvent: true } : {}),
    })
  }
  return jobs
}
