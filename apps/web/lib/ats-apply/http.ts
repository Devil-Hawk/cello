// POST transport for official ATS application APIs.
//
// lib/ats (read side) ships fetchJson() but it is GET-only; submission needs
// POST with a body + auth header, so this is a small dedicated helper. Same
// SSRF posture as the read side: HTTPS only, hostname allowlist, no redirect
// following (redirect:'error'), bounded timeout.

import { assertAllowedHost } from '@/lib/ats'

const DEFAULT_TIMEOUT_MS = 20_000
const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'

export class ApplyHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'ApplyHttpError'
    this.status = status
    this.body = body
  }
}

export interface PostJsonOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  allowedHosts: ReadonlySet<string>
  signal?: AbortSignal
}

/**
 * POST a JSON body to an allow-listed HTTPS host and parse a JSON response.
 * Throws ApplyHttpError on non-2xx (carrying the response body for diagnostics).
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: PostJsonOptions
): Promise<T> {
  assertAllowedHost(url, opts.allowedHosts)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  // Abort if the caller's signal fires (budget exhausted / run cancelled).
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new ApplyHttpError(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}`,
        res.status,
        text.slice(0, 2000)
      )
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      // Some ATS endpoints return a bare success string.
      return { raw: text } as T
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
