// The Researcher's own read-only tools: search the web and read one page.
//
// They are not among the twelve Cello tools. The orchestrator never holds them,
// and they are not served over MCP: they exist so the Researcher, which loops on
// its own, can look things up. Both are read only and both return text anyone could
// have written, so CelloUntrusted quotes the results as data. A page is fetched
// only after the same address checks the MCP client uses: http or https, and no
// hostname that resolves to a private, loopback or metadata address, checked again
// on every redirect.

import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { webSearch } from '@/lib/search'
import { checkSsrf, readLimitedText } from '@/lib/security/untrusted'
import { stripHtml } from '@/lib/sources/util'
import type { AgentContext } from '../context'

const PAGE_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 1_500_000
const MAX_PAGE_CHARS = 6_000
const MAX_REDIRECTS = 3

export const WEB_SEARCH_DESCRIPTION =
  'Search the web. Returns titles, urls and short snippets. Use it to find sources, then read_page to read the best ones. A snippet is not a source: cite only pages you read.'
export const READ_PAGE_DESCRIPTION =
  'Read one public web page and return its text, cut to about 6,000 characters. Pass a url from web_search. Fails with the reason for a private or unreachable address.'

export interface PageResult {
  url: string
  title: string | null
  text: string
}

/** Fetch one page with the address checks. Returns an error the model can act on instead of throwing. */
export async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<PageResult | { error: string; fix: string }> {
  let url = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkSsrf(url)
    if (!check.ok) return { error: `Cannot read ${url}: ${check.message}`, fix: 'Use a public http or https page from web_search.' }
    const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'user-agent': 'cello-researcher/1.0 (+https://cello-two.vercel.app)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      })
    } catch (e) {
      return { error: `Could not load ${url}: ${e instanceof Error ? e.message : String(e)}`, fix: 'Try another source.' }
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) return { error: `${url} redirected without a destination.`, fix: 'Try another source.' }
      url = new URL(next, url).toString()
      continue
    }
    if (!res.ok) return { error: `${url} answered ${res.status}.`, fix: 'Try another source.' }
    const body = await readLimitedText(res, MAX_BODY_BYTES)
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() ?? null
    const contentType = res.headers.get('content-type') ?? ''
    const text = contentType.includes('html') || /^\s*</.test(body) ? stripHtml(body) : body.replace(/\s+/g, ' ').trim()
    return { url, title, text: text.slice(0, MAX_PAGE_CHARS) }
  }
  return { error: `${rawUrl} redirected too many times.`, fix: 'Try another source.' }
}

/** web_search and read_page, bound to one request. */
export function researchPrimitives(ctx: Pick<AgentContext, 'userId' | 'signal'>) {
  const search = tool(
    async ({ query, limit }: { query: string; limit: number }) => {
      const res = await webSearch(query, { limit, userId: ctx.userId, signal: ctx.signal })
      if (!res.ok) return JSON.stringify({ error: `Search failed (${res.reason ?? 'unknown'}).`, fix: 'Try a different query, or say what could not be found.' })
      return JSON.stringify({
        count: res.results.length,
        results: res.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
        ...(res.results.length === 0 ? { note: 'No results. Try different words.' } : {}),
      })
    },
    {
      name: 'web_search',
      description: WEB_SEARCH_DESCRIPTION,
      schema: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    }
  )
  const read = tool(
    async ({ url }: { url: string }) => JSON.stringify(await fetchPage(url, ctx.signal)),
    {
      name: 'read_page',
      description: READ_PAGE_DESCRIPTION,
      schema: z.object({ url: z.string().url().max(500) }),
    }
  )
  return [search, read]
}
