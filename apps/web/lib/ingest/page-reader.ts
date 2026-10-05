// Read a company's careers page when it has no job board of its own.
//
// Order of trust:
//   1. JobPosting markup the page declares (lib/ingest/jsonld.ts): the
//      employer's own data, no model, nothing to verify.
//   2. A free model over a numbered snapshot of the page, whose answer is
//      checked against that snapshot (lib/ingest/snapshot.ts verifyModelJobs).
//   3. Nothing. With no model, no answer or nothing confirmed, the company is
//      reported as not read. Nothing is guessed from link text or slugs.
//
// Then each confirmed posting without a body gets its own page fetched for one
// (lib/ingest/details.ts).

import { z } from 'zod'
import type { AtsJob } from '../ats/types'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { parseJsonLoose } from '../harness/llm'
import { frameJobText } from '../security/job-text'
import { fillDescriptions, MAX_DETAIL_FETCHES } from './details'
import type { FetchPage } from './fetch-page'
import { readJobPostings } from './jsonld'
import { MODEL_LIMIT, type ModelCall } from './model'
import { normalizeJobUrl, snapshotPage, verifyModelJobs, type PageSnapshot } from './snapshot'

export type ReadReason = 'fetch_failed' | 'model_unavailable' | 'model_limit' | 'page_unconfirmed'

export interface PageReadResult {
  jobs: AtsJob[]
  /**
   * True when `jobs` is the whole list, so a stored posting missing from it
   * may count as gone: structured data, or a model listing from a page that was
   * read in full. False otherwise (a partial or unconfirmed read stamps what it
   * saw and closes nothing).
   */
  complete: boolean
  /** Why nothing could be read, or null (including a page that honestly lists no role). */
  reason: ReadReason | null
  modelCalls: number
  /** Model answers the page did not back up. */
  dropped: number
  detail: { fetched: number; filled: number }
}

export interface PageReaderDeps {
  fetchPage: FetchPage
  /** null when no free model can be used (no key). */
  model: ModelCall | null
  /** Fetch one posting's own page; omit to skip the description step. */
  fetchDetail?: (url: string) => Promise<string>
  /** True when no description is stored for this posting. Defaults to "all of them". */
  needsDescription?: (externalId: string) => boolean
}

export const MAX_LISTING_PAGES = 3
const MIN_PAGE_TEXT = 150
const MAX_ANSWER_JOBS = 300

const AnswerSchema = z.object({
  page_kind: z.enum(['listing', 'single_posting', 'no_postings', 'not_a_jobs_page']),
  jobs: z
    .array(
      z.object({
        title: z.string(),
        link: z.number().int().nullable().optional().transform((v) => v ?? null),
        location: z.string().nullable().optional(),
      })
    )
    .max(MAX_ANSWER_JOBS)
    .default([]),
})

export function pageReaderSystemPrompt(): string {
  return composeSystemPrompt({ mode: loadModeDoc('page_reader'), includeVoice: false })
}

export function pageReaderUserPrompt(companyName: string, snap: PageSnapshot): string {
  const links = snap.links.map((l, i) => `[${i + 1}] ${l.label || '(no text)'} -> ${l.href}`).join('\n')
  const page = `<page_text>\n${snap.text}\n</page_text>\n\n<links>\n${links}\n</links>`
  return `Company: ${companyName.trim().slice(0, 120)}\nPage: ${snap.url}\n\n${frameJobText(page, { label: 'CAREERS PAGE', maxChars: 60_000 })}`
}

const NEXT_LABEL = /^(?:next(?: page)?|older|more jobs|show more|load more|[›»>])$/i

/** The next listing page, if this one links to it on the same site. */
function nextPageUrl(snap: PageSnapshot, seen: Set<string>): string | null {
  let here: URL
  try {
    here = new URL(snap.url)
  } catch {
    return null
  }
  for (const link of snap.links) {
    if (!NEXT_LABEL.test(link.label.trim())) continue
    try {
      const to = new URL(link.href)
      if (to.hostname !== here.hostname) continue
      const id = normalizeJobUrl(to.toString())
      if (seen.has(id)) continue
      return to.toString()
    } catch {
      /* not a url */
    }
  }
  return null
}

interface PageOutcome {
  jobs: AtsJob[]
  /** The page proved it lists postings (so asking for its next page is worth it). */
  listed: boolean
  complete: boolean
  reason: ReadReason | null
  dropped: number
}

async function readOnePage(
  company: { name: string },
  html: string,
  url: string,
  deps: PageReaderDeps,
  counter: { calls: number }
): Promise<{ outcome: PageOutcome; snap: PageSnapshot }> {
  const snap = snapshotPage(html, url)

  // 1. What the employer declared.
  const declared = readJobPostings(html, url)
  if (declared.length > 0) {
    return { snap, outcome: { jobs: declared, listed: declared.length > 1, complete: true, reason: null, dropped: 0 } }
  }

  // A page with no text is a shell that builds itself with script; the model has nothing to read.
  if (snap.text.length < MIN_PAGE_TEXT) {
    return { snap, outcome: { jobs: [], listed: false, complete: false, reason: 'page_unconfirmed', dropped: 0 } }
  }
  if (!deps.model) {
    return { snap, outcome: { jobs: [], listed: false, complete: false, reason: 'model_unavailable', dropped: 0 } }
  }

  // 2. A free model, checked against the snapshot.
  counter.calls++
  let raw: string | null | typeof MODEL_LIMIT
  try {
    raw = await deps.model({
      system: pageReaderSystemPrompt(),
      prompt: pageReaderUserPrompt(company.name, snap),
      name: 'read-careers-page',
      maxTokens: 3000,
      promptRef: promptRef('page_reader'),
    })
  } catch {
    raw = null
  }
  if (raw === MODEL_LIMIT) {
    counter.calls--
    return { snap, outcome: { jobs: [], listed: false, complete: false, reason: 'model_limit', dropped: 0 } }
  }
  if (!raw) return { snap, outcome: { jobs: [], listed: false, complete: false, reason: 'model_unavailable', dropped: 0 } }

  let parsed: unknown = null
  try {
    parsed = parseJsonLoose(raw)
  } catch {
    /* handled below */
  }
  const answer = AnswerSchema.safeParse(parsed)
  if (!answer.success) return { snap, outcome: { jobs: [], listed: false, complete: false, reason: 'page_unconfirmed', dropped: 0 } }
  const { page_kind: kind, jobs: named } = answer.data

  if (kind === 'single_posting') {
    const title = named[0]?.title.trim()
    const onPage = title ? snap.text.toLowerCase().includes(title.toLowerCase()) : false
    if (!title || !onPage) return { snap, outcome: { jobs: [], listed: false, complete: false, reason: 'page_unconfirmed', dropped: named.length } }
    return {
      snap,
      outcome: {
        jobs: [{ title, url: snap.url, externalId: normalizeJobUrl(snap.url), description: undefined }],
        listed: false,
        complete: false,
        reason: null,
        dropped: named.length - 1,
      },
    }
  }

  const { kept, dropped } = verifyModelJobs({ page_kind: kind, jobs: named }, snap)
  if (kept.length === 0) {
    // The page honestly shows no role, or the model named roles the page did not back up.
    const reason: ReadReason | null = named.length > 0 ? 'page_unconfirmed' : null
    return { snap, outcome: { jobs: [], listed: false, complete: false, reason, dropped } }
  }
  return {
    snap,
    outcome: { jobs: kept, listed: kind === 'listing', complete: kind === 'listing' && !snap.truncated, reason: null, dropped },
  }
}

/** Read a careers page for the postings it shows. Never throws. */
export async function readCareersPage(company: { name: string; career_url: string }, deps: PageReaderDeps): Promise<PageReadResult> {
  const result: PageReadResult = { jobs: [], complete: false, reason: null, modelCalls: 0, dropped: 0, detail: { fetched: 0, filled: 0 } }
  const counter = { calls: 0 }
  const seenPages = new Set<string>()
  const byId = new Map<string, AtsJob>()
  let url: string | null = company.career_url
  let complete = true
  let firstReason: ReadReason | null = null

  for (let page = 0; page < MAX_LISTING_PAGES && url; page++) {
    seenPages.add(normalizeJobUrl(url))
    let fetched
    try {
      fetched = await deps.fetchPage(url)
    } catch {
      if (page === 0) firstReason = 'fetch_failed'
      complete = false
      break
    }
    seenPages.add(normalizeJobUrl(fetched.finalUrl))
    const { outcome, snap } = await readOnePage(company, fetched.html, fetched.finalUrl, deps, counter)
    result.dropped += outcome.dropped
    for (const job of outcome.jobs) if (!byId.has(job.externalId)) byId.set(job.externalId, job)
    if (page === 0) firstReason = outcome.reason
    if (!outcome.complete) complete = false
    if (outcome.reason === 'model_limit') break
    if (!outcome.listed) break
    // Only a page that proved it lists postings is worth a next page; a link that
    // says "next" on a page that lists nothing is just navigation.
    const next = nextPageUrl(snap, seenPages)
    if (!next) break
    if (page === MAX_LISTING_PAGES - 1) complete = false
    url = next
  }

  result.modelCalls = counter.calls
  let jobs = [...byId.values()]
  if (jobs.length === 0) {
    result.reason = firstReason
    result.complete = false
    return result
  }
  if (deps.fetchDetail) {
    const filled = await fillDescriptions(jobs, {
      needs: deps.needsDescription ?? (() => true),
      fetchHtml: deps.fetchDetail,
      max: MAX_DETAIL_FETCHES,
    })
    jobs = filled.jobs
    result.detail = { fetched: filled.fetched, filled: filled.filled }
  }
  result.jobs = jobs
  result.complete = complete
  // Something was read; a later page that failed is not a reason to call the company unread.
  result.reason = null
  return result
}
