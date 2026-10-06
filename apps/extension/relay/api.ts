import { browser } from 'wxt/browser'
import { DEFAULT_ORIGIN } from '../lib/storage'

// The relay's own client, with the relay token. It knows two routes and no others, so
// the carrier cannot reach anything else on Cello even by mistake, and the fill token
// (a different token, a different scope) is never read here.

export const RELAY_ROUTES = ['/api/model-jobs/claim', '/api/model-jobs/result'] as const
export type RelayRoute = (typeof RELAY_ROUTES)[number]


export interface RelayStore {
  relayToken?: string
  origin?: string
}

export async function readRelayStore(): Promise<RelayStore> {
  return (await browser.storage.local.get(['relayToken', 'origin'])) as RelayStore
}

export async function relayCall<T>(route: RelayRoute, body: unknown, store?: RelayStore): Promise<T | null> {
  if (!(RELAY_ROUTES as readonly string[]).includes(route)) throw new Error('not a relay route')
  const s = store ?? (await readRelayStore())
  if (!s.relayToken) return null
  try {
    const res = await fetch((s.origin || DEFAULT_ORIGIN).replace(/\/$/, '') + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.relayToken}` },
      body: JSON.stringify(body),
    })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}
