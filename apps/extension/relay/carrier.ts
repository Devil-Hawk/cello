import { browser } from 'wxt/browser'
import { startKeepAlive, stopKeepAlive } from '../worker/keepalive'
import { acquireLock, releaseLock } from '../worker/lock'
import { runLocal } from '../../web/lib/relay/local'
import type { LocalConfig, LocalRequest } from '../../web/lib/relay/local'
import { relayCall } from './api'
import type { RelayRoute } from './api'

// The extension carrier. It runs inside the existing five minute alarm: one claim,
// which the server may hold up to 25 seconds, then the job on this computer (R2,
// loopback) or in this browser (R1, the offscreen document) and the answer back.
// There is no timer of its own and no loop. A send and a relay job never run
// together: both take the same lock.

interface Claimed {
  job: { job_id: string; claim_id: string; request: LocalRequest } | null
}

export interface RelayDeps {
  config: () => Promise<LocalConfig | null>
  /** "Run small steps in this browser" is on and this device can do it. */
  browserReady: () => Promise<boolean>
  haveToken: () => Promise<boolean>
  lock: () => Promise<boolean>
  unlock: () => Promise<void>
  keepAlive: { start: () => Promise<void>; stop: () => Promise<void> }
  call: <T>(route: RelayRoute, body: unknown) => Promise<T | null>
  run: (cfg: LocalConfig, req: LocalRequest) => Promise<string>
  runBrowser: (req: LocalRequest) => Promise<string>
}

type Reply = { text?: string; error?: string; reason?: string | null }
const ask = (message: unknown): Promise<Reply> => browser.runtime.sendMessage(message) as Promise<Reply>

const defaults: RelayDeps = {
  config: async () => {
    const r = (await browser.storage.local.get('relayLocal')) as { relayLocal?: LocalConfig }
    return r.relayLocal ?? null
  },
  // The offscreen document answers; it exists while the keep-alive holds it.
  browserReady: async () => {
    const r = (await browser.storage.local.get('relayBrowser')) as { relayBrowser?: boolean }
    return r.relayBrowser === true && (await ask({ type: 'relay-r1-check' }).catch(() => ({ reason: 'x' }))).reason === null
  },
  haveToken: async () => !!((await browser.storage.local.get('relayToken')) as { relayToken?: string }).relayToken,
  lock: () => acquireLock('relay'),
  unlock: () => releaseLock('relay'),
  keepAlive: { start: startKeepAlive, stop: stopKeepAlive },
  call: (route, body) => relayCall(route, body),
  // Plain fetch: the extension's host permission covers loopback, and the page-only
  // local network hint would make Chrome ask for a permission a worker cannot answer.
  run: (cfg, req) => runLocal(cfg, req, (url, init) => fetch(url, init)),
  runBrowser: async (request) => {
    const r = await ask({ type: 'relay-r1', request })
    if (typeof r.text !== 'string') throw new Error(r.error ?? 'The browser model failed.')
    return r.text
  },
}

/** Returns true when a job was claimed (and answered or failed), false otherwise. */
export async function relayTick(d: RelayDeps = defaults): Promise<boolean> {
  const cfg = await d.config()
  if (!(await d.haveToken())) return false
  if (!(await d.lock())) return false
  try {
    await d.keepAlive.start()
    const browserModel = await d.browserReady()
    if (!cfg && !browserModel) return false
    // R2 first; the long wait only when R2 is the one rung this device serves.
    if (cfg && (await serve(d, 'R2', browserModel ? 0 : 25, (req) => d.run(cfg, req)))) return true
    return browserModel ? await serve(d, 'R1', 0, d.runBrowser) : false
  } finally {
    await d.keepAlive.stop()
    await d.unlock()
  }
}

async function serve(d: RelayDeps, rung: 'R1' | 'R2', wait: number, run: (req: LocalRequest) => Promise<string>): Promise<boolean> {
  const claimed = await d.call<Claimed>('/api/model-jobs/claim', { rung, wait })
  const job = claimed?.job
  if (!job) return false
  let answer: { text: string } | { error: string }
  try {
    answer = { text: await run(job.request) }
  } catch (err) {
    answer = { error: err instanceof Error ? err.message.slice(0, 500) : 'The model failed.' }
  }
  await d.call('/api/model-jobs/result', { job_id: job.job_id, claim_id: job.claim_id, ...answer })
  return true
}
