import { browser } from 'wxt/browser'
import type { Claim } from './fill-contract'

// What the extension remembers. `local` survives a browser restart (token, pause,
// the applications a send has already clicked on); `session` is for the run in
// progress. Reads never throw: a missing key is just the default.

export const DEFAULT_ORIGIN: string =
  ((import.meta.env as Record<string, string | undefined>).WXT_CELLO_ORIGIN ?? 'https://cello-two.vercel.app').replace(/\/$/, '')

export interface PresenceInfo {
  at: number
  ok: boolean
  min_version?: string
}

export interface Local {
  origin: string
  token: string
  /** The relay token: scope `relay` only. Never the fill token. */
  relayToken: string
  /** The model on this computer that relay jobs run on. */
  relayLocal: { runtime: 'ollama' | 'lmstudio'; baseUrl: string; model: string }
  /** Run small steps (R1) in this browser, in the offscreen document. */
  relayBrowser: boolean
  paused: boolean
  /** Applications an automatic send has clicked Send on. Never clicked twice. */
  clicked: Record<string, number>
  /** The automatic send under way: a restart reports it instead of repeating it. */
  inflight: { application: string; stage: 'claimed' | 'clicked'; since: number } | null
  presence: PresenceInfo
}

export async function getLocal<K extends keyof Local>(key: K): Promise<Local[K] | undefined> {
  const r = (await browser.storage.local.get(key)) as Partial<Local>
  return r[key]
}

export async function setLocal(patch: Partial<Local>): Promise<void> {
  await browser.storage.local.set(patch)
}

export async function getConnection(): Promise<{ origin: string; token: string | undefined }> {
  const r = (await browser.storage.local.get(['origin', 'token'])) as Partial<Local>
  return { origin: (r.origin || DEFAULT_ORIGIN).replace(/\/$/, ''), token: r.token || undefined }
}

export const isPaused = async (): Promise<boolean> => (await getLocal('paused')) === true

export async function markClicked(application: string): Promise<void> {
  const clicked = (await getLocal('clicked')) ?? {}
  clicked[application] = Date.now()
  await setLocal({ clicked })
}

export async function wasClicked(application: string): Promise<boolean> {
  return !!((await getLocal('clicked')) ?? {})[application]
}

// The session area: the job of each automatic-send tab and the confirmations awaited.
export interface Session {
  jobs: Record<string, { claim: Claim; startedAt: number }>
  pending: Record<string, { application: string; auto: boolean; since: number }>
}

export async function getSession<K extends keyof Session>(key: K): Promise<Session[K]> {
  const r = (await browser.storage.session.get(key)) as Partial<Session>
  return (r[key] ?? {}) as Session[K]
}

export async function setSession<K extends keyof Session>(key: K, value: Session[K]): Promise<void> {
  await browser.storage.session.set({ [key]: value })
}
