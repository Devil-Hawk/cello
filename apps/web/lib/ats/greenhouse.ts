// Greenhouse adapter — public boards API, no auth required.
// GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs

import { htmlToText } from 'html-to-text'
import type { AtsJob, AtsProvider, DetectInput } from './types'
import { isValidToken } from './types'
import { HttpError, assertAllowedHost, fetchJson } from './http'

const API_HOSTS = new Set(['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'])

// Board-hosting hosts we recognize in careers URLs.
const BOARD_URL_RE = /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/

interface GreenhouseJob {
  absolute_url?: string
  title?: string
  location?: { name?: string }
  first_published?: string
  updated_at?: string
  /** Only present when the board is fetched with ?content=true. */
  content?: string
}

// Greenhouse's `content` field is HTML-escaped HTML: the API response's JSON
// string contains literal "&lt;p&gt;...&lt;/p&gt;" rather than "<p>...</p>",
// so the tag delimiters themselves are entity-encoded (verified against a
// live board — see the real-Stripe-response test fixture). A general-purpose
// HTML→text library parses real markup, not text that merely *decodes* to
// markup, so this one entity-unescape pass has to run first — it is not a
// parser, it is un-reversing that double-encoding so `html-to-text` receives
// actual HTML to parse.
function unescapeDoubleEncodedHtml(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

// Convert the (now-real) HTML posting body to the plain text the matcher and
// classifier actually read, via `html-to-text` (a mature, widely-used
// HTML→text library) rather than a hand-rolled regex tag stripper.
// `html-to-text` handles script/style removal and block-vs-inline layout
// correctly on its own — the only overrides needed are the ones that change
// what content ends up in the text: link hrefs and image src/alt are
// dropped (a job description shouldn't read as "Apply here [https://...]"),
// and heading case is left as-authored instead of the default all-caps
// ("BENEFITS") to match what a human reading the original posting would see.
const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
}

function descriptionToText(raw: string): string | undefined {
  try {
    const text = htmlToText(unescapeDoubleEncodedHtml(raw), HTML_TO_TEXT_OPTIONS).trim()
    return text || undefined
  } catch {
    // A malformed body should degrade to no description rather than throw
    // and lose the whole board.
    return undefined
  }
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[]
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function detect(input: DetectInput): { token: string } | null {
  if (!input.careerUrl) return null
  let url: URL
  try {
    url = new URL(input.careerUrl)
  } catch {
    return null
  }
  if (!BOARD_URL_RE.test(url.hostname)) return null

  // Embedded boards: boards.greenhouse.io/embed/job_board?for={token}
  const segments = url.pathname.split('/').filter(Boolean)
  let token: string | undefined
  if (segments[0] === 'embed') {
    token = url.searchParams.get('for') ?? undefined
  } else {
    token = segments[0]
  }
  return isValidToken(token) ? { token } : null
}

async function fetchBoard(host: string, token: string): Promise<AtsJob[]> {
  // content=true is what makes the API return the posting body. Without it
  // every job arrives as title + location only, which is why 13,043 stored
  // Greenhouse jobs had no description and could only ever be scored on their
  // title. One list call still covers the whole board, so this costs one
  // request, not one per job.
  const apiUrl = `https://${host}/v1/boards/${token}/jobs?content=true`
  assertAllowedHost(apiUrl, API_HOSTS)
  const json = await fetchJson<GreenhouseResponse>(apiUrl)
  const jobs = Array.isArray(json?.jobs) ? json.jobs : []
  const results: AtsJob[] = []
  for (const j of jobs) {
    if (!j || typeof j.absolute_url !== 'string' || !j.absolute_url) continue
    results.push({
      title: typeof j.title === 'string' ? j.title : '',
      url: j.absolute_url,
      externalId: j.absolute_url,
      location: j.location?.name || undefined,
      description: typeof j.content === 'string' && j.content ? descriptionToText(j.content) : undefined,
      postedAt: toIso(j.first_published) ?? toIso(j.updated_at),
    })
  }
  return results
}

async function fetchJobs(token: string): Promise<AtsJob[]> {
  if (!isValidToken(token)) throw new Error(`greenhouse: invalid board token`)
  try {
    return await fetchBoard('boards-api.greenhouse.io', token)
  } catch (error) {
    // EU-region boards are only served by the EU API host.
    if (error instanceof HttpError && error.status === 404) {
      return await fetchBoard('boards-api.eu.greenhouse.io', token)
    }
    throw error
  }
}

export const greenhouse: AtsProvider = {
  id: 'greenhouse',
  detect,
  fetch: fetchJobs,
}
