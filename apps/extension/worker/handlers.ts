import { browser } from 'wxt/browser'
import type { Browser } from 'wxt/browser'
import { callApi, fetchFile, isRoute, version } from '../lib/api'
import { ROUTES } from '../lib/fill-contract'
import type { NextResponse } from '../lib/fill-contract'
import type { ApiResult, FileReply, Hello, ToWorker } from '../lib/messages'
import { getConnection, getSession, isPaused, setLocal, setSession, DEFAULT_ORIGIN } from '../lib/storage'
import { presence } from './presence'
import { finish, recordClick } from './send'
import { captureConfirmation } from './shots'
import { toBase64 } from './shots'

// Reports to Cello go one at a time, so "submitted" is always heard before "confirmation".
let reportChain: Promise<unknown> = Promise.resolve()

function api(route: string, body: unknown): Promise<ApiResult> {
  if (!isRoute(route)) return Promise.resolve({ ok: false, status: 0, error: 'not_allowed' })
  if (route !== ROUTES.report) return callApi(route, body)
  const next = reportChain.then(() => callApi(route, body))
  reportChain = next.catch(() => undefined)
  return next
}

async function hello(tabId: number | undefined): Promise<Hello> {
  const key = String(tabId)
  const jobs = await getSession('jobs')
  const pending = await getSession('pending')
  return { job: jobs[key] ?? null, pending: pending[key] ?? null, paused: await isPaused() }
}

export async function handle(msg: ToWorker, sender: Browser.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id
  switch (msg.type) {
    case 'api':
      return api(msg.route, msg.body)
    case 'file': {
      const f = await fetchFile(msg.url)
      return f ? ({ mime: f.mime, data: toBase64(f.bytes) } satisfies FileReply) : null
    }
    case 'screenshot':
      return captureConfirmation(sender.tab?.windowId)
    case 'hello':
      return hello(tabId)
    case 'pause': {
      await setLocal({ paused: true })
      return callApi(ROUTES.pause, { paused: true })
    }
    case 'resume': {
      await setLocal({ paused: false })
      return callApi(ROUTES.pause, { paused: false })
    }
    case 'clicked':
      return recordClick(msg.application)
    case 'pending': {
      if (tabId === undefined) return false
      const pending = await getSession('pending')
      if (msg.pending) pending[String(tabId)] = msg.pending
      else delete pending[String(tabId)]
      await setSession('pending', pending)
      return true
    }
    case 'outcome':
      finish(msg.application, msg.outcome, msg.keepOpen)
      return true
    case 'next': {
      const r = await callApi<NextResponse>(ROUTES.next, { auto: false, version: version() })
      const next = r.ok ? r.data?.next : undefined
      if (!next) return { opened: false }
      await browser.tabs.create({ url: next.url })
      return { opened: true }
    }
  }
}

/** The Cello page hands over the token (Connect the extension). Only the Cello origin may. */
export async function handleExternal(msg: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> {
  const { origin } = await getConnection()
  const allowed = new Set([new URL(origin).origin, new URL(DEFAULT_ORIGIN).origin])
  if (!sender.origin || !allowed.has(sender.origin)) return { ok: false }
  const m = msg as { type?: string; token?: unknown }
  if (m?.type === 'cello-ping') return { ok: true, version: version() }
  if (m?.type === 'cello-connect' && typeof m.token === 'string' && m.token.length > 0 && m.token.length < 512) {
    await setLocal({ token: m.token })
    void presence()
    return { ok: true, version: version() }
  }
  return { ok: false }
}
