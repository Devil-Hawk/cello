import { browser } from 'wxt/browser'
import { callApi } from '../lib/api'
import { ROUTES } from '../lib/fill-contract'
import type { Claim } from '../lib/fill-contract'
import type { Outcome } from '../lib/messages'
import { getLocal, getSession, markClicked, setLocal, setSession, wasClicked } from '../lib/storage'
import { hostListed } from '../fill/hosts'
import { startKeepAlive, stopKeepAlive } from './keepalive'
import { acquireLock, releaseLock } from './lock'

// Send for me, the worker half: one claim at a time, one unfocused window, one tab.
// The page half (fill/auto.ts) does the reading, the filling and the single click.

const RUN_LIMIT_MS = 120_000
const CONFIRM_MS = Number((import.meta.env as Record<string, string | undefined>).WXT_CELLO_CONFIRM_MS) || 30_000

interface Done {
  outcome: Outcome
  keepOpen: boolean
  timedOut?: boolean
}
const waiters = new Map<string, (d: Done) => void>()
const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** The page reports its outcome; the run that opened the tab hears it. */
export function finish(application: string, outcome: Outcome, keepOpen = false): void {
  waiters.get(application)?.({ outcome, keepOpen })
}

export async function runAutoSend(claim: Claim): Promise<void> {
  const app = claim.application
  const blocked = (cause: 'wrong_page' | 'interrupted'): Promise<unknown> =>
    callApi(ROUTES.report, { phase: 'blocked', application: app, url: claim.url, cause })

  // Never twice, even if the server hands the same application out again.
  if (await wasClicked(app)) {
    await callApi(ROUTES.report, { phase: 'unconfirmed', application: app, cause: 'already_clicked' })
    return
  }
  // Only a host the server named. Anything else is not opened.
  if (!hostListed(claim.url, claim.hosts)) {
    await blocked('wrong_page')
    return
  }
  if (!(await acquireLock('send'))) return

  let windowId: number | undefined
  let tabId: number | undefined
  let limit: ReturnType<typeof setTimeout> | undefined
  let done: Done = { outcome: 'blocked', keepOpen: false }
  try {
    await setLocal({ inflight: { application: app, stage: 'claimed', since: Date.now() } })
    await startKeepAlive()
    const wait = new Promise<Done>((resolve) => {
      waiters.set(app, resolve)
      limit = setTimeout(() => resolve({ outcome: 'blocked', keepOpen: false, timedOut: true }), RUN_LIMIT_MS)
    })
    const win = await browser.windows.create({ url: 'about:blank', focused: false, type: 'normal' })
    windowId = win.id
    tabId = win.tabs?.[0]?.id
    if (tabId === undefined) throw new Error('no tab')
    const jobs = await getSession('jobs')
    jobs[String(tabId)] = { claim, startedAt: Date.now() }
    await setSession('jobs', jobs)
    await browser.tabs.update(tabId, { url: claim.url })
    done = await wait
    // The page reports its own stops. Only a run that ran out of time is reported here.
    if (done.timedOut) await blocked('interrupted')
  } catch {
    await blocked('interrupted').catch(() => undefined)
  } finally {
    clearTimeout(limit)
    waiters.delete(app)
    clearTimeout(confirmTimers.get(app))
    confirmTimers.delete(app)
    await setLocal({ inflight: null })
    if (tabId !== undefined) {
      const jobs = await getSession('jobs')
      delete jobs[String(tabId)]
      await setSession('jobs', jobs)
      const pending = await getSession('pending')
      delete pending[String(tabId)]
      await setSession('pending', pending)
    }
    if (windowId !== undefined && !done.keepOpen) await browser.windows.remove(windowId).catch(() => undefined)
    await stopKeepAlive()
    await releaseLock('send')
  }
}

/** Written before an automatic click. False means this application was clicked already. */
export async function recordClick(application: string): Promise<boolean> {
  if (await wasClicked(application)) return false
  await markClicked(application)
  await setLocal({ inflight: { application, stage: 'clicked', since: Date.now() } })
  // The page may navigate somewhere with no script: the window to see a confirmation closes here.
  confirmTimers.set(
    application,
    setTimeout(() => {
      void callApi(ROUTES.report, { phase: 'unconfirmed', application, cause: 'no_confirmation' })
      finish(application, 'unconfirmed', true)
    }, CONFIRM_MS + 3000),
  )
  return true
}

/** A restart reports what it interrupted; it never retries. */
export async function recover(): Promise<void> {
  const inflight = await getLocal('inflight')
  if (!inflight) return
  await setLocal({ inflight: null })
  await callApi(
    ROUTES.report,
    inflight.stage === 'clicked'
      ? { phase: 'unconfirmed', application: inflight.application, cause: 'interrupted' }
      : { phase: 'blocked', application: inflight.application, url: '', cause: 'interrupted' },
  )
}
