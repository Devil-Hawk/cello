// A careers page lists titles; the posting's own page holds the text. For the
// postings a refresh just confirmed and has no description for, fetch that page
// and keep what it says, so a job found this way is not stored as a title with
// nothing under it.

import * as cheerio from 'cheerio'
import type { AtsJob } from '../ats/types'
import { htmlToPlainText } from '../ats/html'
import { mapWithConcurrency } from '../ats/concurrency'
import { readJobPostings } from './jsonld'

const MIN_DESCRIPTION_CHARS = 200
const CONCURRENCY = 3
export const MAX_DETAIL_FETCHES = 15

const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * The description a posting's own page holds, or undefined. Prefers what the
 * employer declared (JSON-LD), else the page's main region (or its body without
 * navigation, header, footer and forms). Kept only when the page names the job
 * (a redirect to a generic page must not give the job somebody else's text) and
 * is long enough to be a description.
 */
export function descriptionFromPage(html: string, url: string, title: string): string | undefined {
  const wanted = normText(title)
  if (!wanted) return undefined

  const declared = readJobPostings(html, url).find((p) => normText(p.title) === wanted && p.description)
  if (declared?.description && declared.description.length >= MIN_DESCRIPTION_CHARS) return declared.description

  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html)
  } catch {
    return undefined
  }
  $('script,style,noscript,svg,iframe,template,nav,header,footer,form,aside').remove()
  const region = ['main', 'article', '[role=main]'].map((sel) => $(sel).first()).find((el) => el.length && el.text().trim().length >= MIN_DESCRIPTION_CHARS)
  const root = region ?? $('body')
  const text = htmlToPlainText(root.html() ?? '')
  if (!text || text.length < MIN_DESCRIPTION_CHARS) return undefined
  return normText(text).includes(wanted) ? text : undefined
}

export interface FillOptions {
  /** True when no description is stored for this posting yet. */
  needs: (externalId: string) => boolean
  fetchHtml: (url: string) => Promise<string>
  max?: number
}

/**
 * Return `jobs` with descriptions filled from each posting's own page, for at
 * most `max` of them. Postings that carry one already, or that the store has
 * one for, are not fetched; a posting that was never described goes before one
 * that merely might have changed. A page that fails or does not name the job
 * leaves it as it was.
 */
export async function fillDescriptions(jobs: AtsJob[], opts: FillOptions): Promise<{ jobs: AtsJob[]; fetched: number; filled: number }> {
  const todo = jobs.filter((j) => !j.description && opts.needs(j.externalId)).slice(0, opts.max ?? MAX_DETAIL_FETCHES)
  const found = new Map<string, string>()
  await mapWithConcurrency(todo, CONCURRENCY, async (job) => {
    try {
      const text = descriptionFromPage(await opts.fetchHtml(job.url), job.url, job.title)
      if (text) found.set(job.externalId, text)
    } catch {
      /* the posting stays as listed */
    }
  })
  return {
    jobs: jobs.map((j) => (found.has(j.externalId) ? { ...j, description: found.get(j.externalId) } : j)),
    fetched: todo.length,
    filled: found.size,
  }
}
