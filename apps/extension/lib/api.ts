import { browser } from 'wxt/browser'
import type { Route } from './fill-contract'
import { ROUTES } from './fill-contract'
import type { ApiResult, ExtensionStatus } from './messages'
import { getConnection } from './storage'

// The one client for Cello's fill routes. Worker only: it holds the token.

export const version = (): string => browser.runtime.getManifest().version

const ALLOWED = new Set<string>(Object.values(ROUTES))
export const isRoute = (r: string): r is Route => ALLOWED.has(r)

export async function callApi<T = unknown>(route: Route, body: unknown): Promise<ApiResult<T>> {
  const { origin, token } = await getConnection()
  if (!token) return { ok: false, status: 0, error: 'not_connected' }
  try {
    const res = await fetch(origin + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-cello-extension-version': version(),
      },
      body: JSON.stringify(body),
    })
    const raw = await res.text()
    let data: unknown = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = null
    }
    return res.ok ? { ok: true, status: res.status, data: data as T } : { ok: false, status: res.status, error: raw.slice(0, 200) }
  } catch {
    return { ok: false, status: 0, error: 'network' }
  }
}

/** The popup's numbers, from Cello's own count. Null when Cello cannot be reached or the token is refused. */
export async function getStatus(): Promise<ExtensionStatus | null> {
  const { origin, token } = await getConnection()
  if (!token) return null
  try {
    const res = await fetch(`${origin}/api/extension/status`, {
      headers: { authorization: `Bearer ${token}`, 'x-cello-extension-version': version() },
    })
    return res.ok ? ((await res.json()) as ExtensionStatus) : null
  } catch {
    return null
  }
}

/** Fetch a file on the Cello origin with the token (the resume the session served). */
export async function fetchFile(path: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const { origin, token } = await getConnection()
  if (!token) return null
  // Only a path on the Cello origin: never an address the response chose.
  const url = new URL(path, origin + '/')
  if (url.origin !== new URL(origin).origin) return null
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-cello-extension-version': version() } })
    if (!res.ok) return null
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/pdf' }
  } catch {
    return null
  }
}
