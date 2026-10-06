// Getting a careers page's HTML. Two ways, one shape:
//
//   staticFetchPage   a plain request. What the in-app button uses (Vercel has
//                     no Python and no browser), and the first thing tried.
//   pythonFetchPage   packages/scrapers `python -m src.page`: the same request,
//                     then a rendered browser view when the page builds its
//                     list with script. Used by the scheduled check, which runs
//                     where those are installed.
//
// Both only return HTML. Everything that reads it is TypeScript, so the scheduled
// check and the in-app button read a page identically.

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { assertSsrfSafe } from '../security/untrusted'
import { makeSiteFetcher } from './reader/site-fetch'

export interface FetchedPage {
  html: string
  /** The address the page was served from, after redirects. */
  finalUrl: string
  /** True when a browser had to render it. */
  rendered: boolean
}

/** `render` asks for the browser view even when the plain page looks complete (the plain tiers already found no role in it). */
export type FetchPage = (url: string, opts?: { render?: boolean }) => Promise<FetchedPage>

/**
 * A plain GET through the site fetcher (lib/ingest/reader/site-fetch.ts):
 * robots.txt, a delay, a size cap, an SSRF check on every hop and the Cello user
 * agent. Throws Error(reason), never with the url.
 */
export const staticFetchPage: FetchPage = async (url) => {
  const res = await makeSiteFetcher({ mode: 'inline' }).get(url)
  if (!res.ok) throw new Error(`http_${res.status}`)
  if (res.contentType && !/html|xml|text/i.test(res.contentType)) throw new Error('not_html')
  return { html: res.text, finalUrl: res.finalUrl, rendered: false }
}

/** The check runs from apps/web (like the prompt loader), so the scrapers package is two levels up. */
const scrapersDir = () => process.env.INGEST_SCRAPERS_DIR ?? resolve(process.cwd(), '../../packages/scrapers')

/**
 * Run the Python page fetcher. The child gets only what it needs to find
 * Python and a browser, none of our secrets, and its failures arrive as a class
 * name so nothing it prints (a url, a page) reaches the log.
 */
export const pythonFetchPage: FetchPage = async (url, opts) => {
  await assertSsrfSafe(url)
  return new Promise((resolvePage, reject) => {
    execFile(
      process.env.INGEST_PYTHON ?? 'python',
      ['-m', 'src.page', url, ...(opts?.render ? ['--render'] : [])],
      {
        cwd: scrapersDir(),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 150_000,
        maxBuffer: 20_000_000,
      },
      (error, stdout) => {
        if (error) return reject(new Error('fetcher_failed'))
        try {
          const out = JSON.parse(stdout.trim().split('\n').pop() ?? '') as {
            ok?: boolean
            html?: string
            final_url?: string
            rendered?: boolean
            error?: string
            /** The browser was asked for and could not run: its error class (PlaywrightMissing, TimeoutError, ...). */
            render_error?: string
          }
          if (!out.ok || typeof out.html !== 'string') return reject(new Error(out.error ? `fetcher_${out.error}` : 'fetcher_failed'))
          // A render that was asked for and did not happen is a failure of the browser step, not a page with nothing on it.
          if (opts?.render && out.render_error) return reject(new Error(`fetcher_render_${out.render_error.replace(/[^\w]/g, '').slice(0, 40)}`))
          resolvePage({ html: out.html, finalUrl: out.final_url || url, rendered: out.rendered === true })
        } catch {
          reject(new Error('fetcher_unreadable'))
        }
      }
    )
  })
}

export function pageFetcherFromEnv(kind: string | undefined): FetchPage {
  return kind === 'python' ? pythonFetchPage : staticFetchPage
}
