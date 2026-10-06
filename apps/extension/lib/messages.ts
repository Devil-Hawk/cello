import { browser } from 'wxt/browser'
import type { Claim, Route } from './fill-contract'

// Messages between the content script and the worker. The worker is the only
// place that talks to Cello, so the token never reaches a web page's process.

export type ApiResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string }

export type Outcome = 'sent' | 'blocked' | 'unconfirmed' | 'abandoned'

/** An application whose submit the person (or a send) made and whose confirmation is awaited. */
export interface Pending {
  application: string
  auto: boolean
  since: number
}

export type ToWorker =
  | { type: 'api'; route: Route; body: unknown }
  | { type: 'file'; url: string }
  | { type: 'screenshot' }
  | { type: 'hello' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Written before an automatic click, so a restart can never click again. */
  | { type: 'clicked'; application: string }
  | { type: 'pending'; pending: Pending | null }
  | { type: 'outcome'; application: string; outcome: Outcome; keepOpen?: boolean }
  | { type: 'next' }

export interface Hello {
  /** Set when this tab is an automatic send's tab. */
  job: { claim: Claim; startedAt: number } | null
  pending: Pending | null
  paused: boolean
}

export interface FileReply {
  mime: string
  /** base64 */
  data: string
}

export function send<T>(m: ToWorker): Promise<T> {
  return browser.runtime.sendMessage(m) as Promise<T>
}
