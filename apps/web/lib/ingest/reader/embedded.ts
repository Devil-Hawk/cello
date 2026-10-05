// A role page that builds itself in the browser still ships the role as data in
// its own HTML: Apple's __staticRouterHydrationData, a Next.js __NEXT_DATA__
// block, a <script type="application/json">. This reads that data, never the
// rendered page, and only keeps an object that looks like one posting (a title
// plus a description or summary), so a site's menu data or config is never a role.

import * as cheerio from 'cheerio'
import { htmlToPlainText } from '../../ats/html'

type Json = Record<string, unknown>

export interface EmbeddedPosting {
  title: string
  location?: string
  description?: string
  postedAt?: string
}

const MAX_SCRIPT = 3_000_000
const MAX_NODES = 60_000

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** JSON in a page: a JSON script block, or JSON.parse("...") inside an inline script. */
function blobs(html: string): unknown[] {
  const out: unknown[] = []
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return out
  }
  $('script').each((_, el) => {
    const type = ($(el).attr('type') ?? '').toLowerCase()
    const body = $(el).html() ?? ''
    if (!body || body.length > MAX_SCRIPT || type === 'application/ld+json') return
    if (type === 'application/json') {
      try {
        out.push(JSON.parse(body))
      } catch {
        /* not json */
      }
      return
    }
    for (const m of body.matchAll(/JSON\.parse\(("(?:[^"\\]|\\.)*")\)/g)) {
      try {
        out.push(JSON.parse(JSON.parse(m[1]) as string))
      } catch {
        /* not json */
      }
    }
  })
  return out
}

const TITLE_KEYS = ['postingTitle', 'jobTitle', 'title']
const BODY_KEYS = ['description', 'jobSummary', 'jobDescription']

function looksLikePosting(o: Json): boolean {
  return TITLE_KEYS.some((k) => text(o[k]).length >= 3) && BODY_KEYS.some((k) => text(o[k]).length >= 40)
}

function findPosting(root: unknown): Json | null {
  let seen = 0
  const stack: unknown[] = [root]
  while (stack.length && seen < MAX_NODES) {
    const v = stack.pop()
    seen++
    if (Array.isArray(v)) stack.push(...v)
    else if (isObject(v)) {
      if (looksLikePosting(v)) return v
      stack.push(...Object.values(v))
    }
  }
  return null
}

/** "Seattle, Washington, United States" from {name|city, stateProvince|state, countryName|country}. */
function placeOf(p: unknown): string {
  if (typeof p === 'string') return p.trim()
  if (!isObject(p)) return ''
  const parts = [text(p.city) || text(p.name), text(p.stateProvince) || text(p.state) || text(p.region), text(p.countryName) || text(p.country)].filter(Boolean)
  return [...new Set(parts)].join(', ')
}

function locationOf(o: Json): string | undefined {
  // Apple names the one place this address is for (selectedLocation) beside the list of all of them.
  const raw = o.selectedLocation ?? o.locations ?? o.location ?? o.jobLocation
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(placeOf).filter(Boolean)
  const places = [...new Set(list)].slice(0, 3)
  return places.length ? places.join(' · ') : undefined
}

const plain = (s: string) => htmlToPlainText(s.includes('<') ? s : `<p>${s.replace(/\n/g, '<br>')}</p>`)

/** The posting a page's embedded data carries, or null. Qualifications go in as headed sections so the requirements parser finds them. */
export function readEmbeddedPosting(html: string): EmbeddedPosting | null {
  for (const blob of blobs(html)) {
    const o = findPosting(blob)
    if (!o) continue
    const title = TITLE_KEYS.map((k) => text(o[k])).find((t) => t.length >= 3) ?? ''
    const section = (heading: string, v: unknown) => (text(v) ? `${heading}\n${plain(text(v))}` : '')
    const body = [
      plain(text(o.jobSummary)),
      plain(text(o.description ?? o.jobDescription)),
      section('Responsibilities', o.responsibilities),
      section('Minimum Qualifications', o.minimumQualifications),
      section('Preferred Qualifications', o.preferredQualifications),
    ]
      .filter(Boolean)
      .join('\n\n')
    const posted = text(o.postDateInGMT) || text(o.datePosted) || text(o.postingDate)
    const t = Date.parse(posted)
    return { title, location: locationOf(o), description: body || undefined, postedAt: Number.isNaN(t) ? undefined : new Date(t).toISOString() }
  }
  return null
}
