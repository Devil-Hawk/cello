import { browser } from 'wxt/browser'
import { callApi, version } from '../lib/api'
import { ROUTES } from '../lib/fill-contract'
import type { NextResponse } from '../lib/fill-contract'
import { needsUpdate } from '../lib/version'
import { isPaused, setLocal } from '../lib/storage'
import { relayTick } from '../relay/carrier'
import { lockHolder } from './lock'
import { runAutoSend } from './send'

export const PRESENCE_ALARM = 'cello-presence'

/** Every five minutes while the browser is open. Idempotent: creating it again keeps one. */
export async function ensureAlarm(): Promise<void> {
  if (!(await browser.alarms.get(PRESENCE_ALARM))) {
    await browser.alarms.create(PRESENCE_ALARM, { delayInMinutes: 1, periodInMinutes: 5 })
  }
}

/**
 * The alarm's one call: tells Cello the extension is here (last seen, version) and
 * asks for one claimed application. The server answers with nothing while Send for
 * me is off, paused, in quiet hours or below the minimum version.
 */
async function ping(): Promise<void> {
  // Ask for a claim only when this browser could act on it right now.
  const canSend = !(await isPaused()) && (await lockHolder()) === null
  const r = await callApi<NextResponse>(ROUTES.next, { auto: canSend, version: version() })
  await setLocal({
    presence: { at: Date.now(), ok: r.ok, min_version: r.ok ? r.data?.min_version : undefined },
  })
  if (!r.ok || !r.data) return
  const claim = r.data.claim
  if (!claim) return
  // An old build, a pause or a relay job in progress: no send.
  if (needsUpdate(version(), r.data.min_version)) return
  if (await isPaused()) return
  if ((await lockHolder()) !== null) return
  await runAutoSend(claim)
}

/** What each alarm does: presence and any send first, then one relay claim. They never overlap. */
export async function presence(): Promise<void> {
  await ping()
  await relayTick().catch(() => false)
}
