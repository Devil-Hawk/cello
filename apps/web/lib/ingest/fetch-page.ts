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
import { assertSsrfSafe, readLimitedText } from '../security/untrusted'

export interface FetchedPage {
  html: string
  /** The address the page was served from, after redirects. */
  finalUrl: string
  /** True when a browser had to render it. */
  rendered: boolean
}

export type FetchPage = (url: string) => Promise<FetchedPage>

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAX_HOPS = 4
const MAX_BYTES = 5_000_000

/** A plain GET that checks every hop for SSRF and caps the body. Throws Error(reason), never with the url. */
export const staticFetchPage: FetchPage = async (url) => {
  let current = url
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertSsrfSafe(current)
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error('redirect_without_location')
      current = new URL(location, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`http_${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    if (type && !/html|xml|text/i.test(type)) throw new Error('not_html')
    return { html: await readLimitedText(res, MAX_BYTES), finalUrl: current, rendered: false }
  }
  throw new Error('too_many_redirects')
}

/** The check runs from apps/web (like the prompt loader), so the scrapers package is two levels up. */
const scrapersDir = () => process.env.INGEST_SCRAPERS_DIR ?? resolve(process.cwd(), '../../packages/scrapers')

/**
 * Run the Python page fetcher. The child gets only what it needs to find
 * Python and a browser, none of our secrets, and its failures arrive as a class
 * name so nothing it prints (a url, a page) reaches the log.
 */
export const pythonFetchPage: FetchPage = async (url) => {
  await assertSsrfSafe(url)
  return new Promise((resolvePage, reject) => {
    execFile(
      process.env.INGEST_PYTHON ?? 'python',
      ['-m', 'src.page', url],
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
          }
          if (!out.ok || typeof out.html !== 'string') return reject(new Error(out.error ? `fetcher_${out.error}` : 'fetcher_failed'))
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
