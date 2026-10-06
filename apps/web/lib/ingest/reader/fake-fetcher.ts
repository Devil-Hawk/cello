// A SiteFetcher over recorded responses, for tests: no network, no clock.
// Routes are exact addresses (a fragment is ignored). A route is a body, or an
// object with a status, body, location (a redirect) or an error (a ReaderError
// reason). A site's robots.txt is just the route `<origin>/robots.txt`.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import robotsParser from 'robots-parser'
import { ReaderError, type ReaderReason, type SiteFetcher, type SiteResponse } from './site-fetch'

export type Route = string | { status?: number; body?: string; location?: string; error?: ReaderReason; contentType?: string }

export const fixture = (name: string): string => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8')

export type FakeFetcher = SiteFetcher & { calls: string[]; jsonCalls: { url: string; body?: string }[] }

export function fakeFetcher(routes: Record<string, Route>, mode: 'inline' | 'scheduled' = 'inline'): FakeFetcher {
  const calls: string[] = []
  const jsonCalls: { url: string; body?: string }[] = []
  const norm = (u: string) => u.split('#')[0]
  const routeOf = (u: string): Route | undefined => routes[norm(u)]
  const robotsOf = (url: string) => {
    const r = routeOf(`${new URL(url).origin}/robots.txt`)
    const text = typeof r === 'string' ? r : r?.body
    return text ? robotsParser(`${new URL(url).origin}/robots.txt`, text) : null
  }
  const allowed = async (url: string) => robotsOf(url)?.isAllowed(url, 'cello-job-tracker') !== false

  const f: FakeFetcher = {
    mode,
    calls,
    jsonCalls,
    allowed,
    spent: () => ({ requests: calls.length, bytes: 0 }),
    async sitemapsOf(origin) {
      const named = robotsOf(`${origin}/`)?.getSitemaps() ?? []
      return named.length ? named : [`${origin}/sitemap.xml`]
    },
    async get(url): Promise<SiteResponse> {
      let current = norm(url)
      for (let hop = 0; hop < 5; hop++) {
        if (!(await allowed(current))) throw new ReaderError('robots')
        calls.push(current)
        const r = routeOf(current)
        if (typeof r === 'object' && r.error) throw new ReaderError(r.error)
        if (typeof r === 'object' && r.location) {
          current = norm(new URL(r.location, current).toString())
          continue
        }
        const status = typeof r === 'object' ? (r.status ?? 200) : r === undefined ? 404 : 200
        const body = typeof r === 'string' ? r : (r?.body ?? (r === undefined ? 'not found' : ''))
        return { status, ok: status >= 200 && status < 300, text: body, finalUrl: current, contentType: typeof r === 'object' ? (r.contentType ?? 'text/html') : 'text/html' }
      }
      throw new ReaderError('unreachable')
    },
    async gate(url) {
      if (!(await allowed(url))) throw new ReaderError('robots')
    },
    async redirectOf(url) {
      calls.push(`redirect:${norm(url)}`)
      const r = routeOf(url)
      return typeof r === 'object' && r.location ? new URL(r.location, url).toString() : null
    },
    async json<T>(url: string, opts: { body?: string }) {
      if (!(await allowed(url))) throw new ReaderError('robots')
      calls.push(url)
      jsonCalls.push({ url, body: opts.body })
      const r = routeOf(url) ?? routes[`${url.split('?')[0]}*`]
      if (typeof r === 'object' && r.error) throw new ReaderError(r.error)
      const body = typeof r === 'string' ? r : r?.body
      if (body === undefined) throw new ReaderError('unreachable')
      return JSON.parse(body) as T
    },
  }
  return f
}
