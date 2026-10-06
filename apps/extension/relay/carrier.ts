import { browser } from 'wxt/browser'
import { startKeepAlive, stopKeepAlive } from '../worker/keepalive'
import { acquireLock, releaseLock } from '../worker/lock'
import { relayCall } from './api'
import type { RelayRoute } from './api'
import { runLocal } from '../../web/lib/relay/local'
import type { LocalConfig, LocalRequest as JobRequest } from '../../web/lib/relay/local'

// The extension carrier. It runs inside the existing five minute alarm: one claim,
// which the server may hold up to 25 seconds, then the job on loopback and the answer
// back. There is no timer of its own and no loop. A send and a relay job never run
// together: both take the same lock.

interface Claimed {
  job: { job_id: string; claim_id: string; request: JobRequest } | null
}

export interface RelayDeps {
  config: () => Promise<LocalConfig | null>
  haveToken: () => Promise<boolean>
  lock: () => Promise<boolean>
  unlock: () => Promise<void>
  keepAlive: { start: () => Promise<void>; stop: () => Promise<void> }
  call: <T>(route: RelayRoute, body: unknown) => Promise<T | null>
  run: (cfg: LocalConfig, req: JobRequest) => Promise<string>
}

const defaults: RelayDeps = {
  config: async () => {
    const r = (await browser.storage.local.get('relayLocal')) as { relayLocal?: LocalConfig }
    return r.relayLocal ?? null
  },
  haveToken: async () => !!((await browser.storage.local.get('relayToken')) as { relayToken?: string }).relayToken,
  lock: () => acquireLock('relay'),
  unlock: () => releaseLock('relay'),
  keepAlive: { start: startKeepAlive, stop: stopKeepAlive },
  call: (route, body) => relayCall(route, body),
  // Plain fetch: the extension's host permission covers loopback, and the page-only
  // local network hint would make Chrome ask for a permission a worker cannot answer.
  run: (cfg, req) => runLocal(cfg, req, (url, init) => fetch(url, init)),
}

/** Returns true when a job was claimed (and answered or failed), false otherwise. */
export async function relayTick(d: RelayDeps = defaults): Promise<boolean> {
  const cfg = await d.config()
  if (!cfg || !(await d.haveToken())) return false
  if (!(await d.lock())) return false
  try {
    await d.keepAlive.start()
    const claimed = await d.call<Claimed>('/api/model-jobs/claim', { rung: 'R2', wait: 25 })
    const job = claimed?.job
    if (!job) return false
    let answer: { text: string } | { error: string }
    try {
      answer = { text: await d.run(cfg, job.request) }
    } catch (err) {
      answer = { error: err instanceof Error ? err.message.slice(0, 500) : 'The local model failed.' }
    }
    await d.call('/api/model-jobs/result', { job_id: job.job_id, claim_id: job.claim_id, ...answer })
    return true
  } finally {
    await d.keepAlive.stop()
    await d.unlock()
  }
}
