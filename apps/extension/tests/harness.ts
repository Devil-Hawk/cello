import { chromium, expect, test as base } from '@playwright/test'
import type { BrowserContext, Page, Worker } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AutoHost, Claim } from '../lib/fill-contract'
import { ATS_HOSTS } from '../fill/hosts'
import { Stub, TOKEN } from './fill-server.stub'
import { CHALLENGE_FRAME, confirmation } from './fixtures/pages'

// The unpacked test build: WXT_CELLO_ORIGIN=http://127.0.0.1:4599 pnpm build.
export const EXT = path.resolve(__dirname, '../.output/chrome-mv3')

export interface Site {
  /** host + path to a page, or a redirect */
  pages: Map<string, string | { redirect: string }>
  submits: number
  clicks: number
  challengeHits: number
  noisy: boolean
}

/** Serves the fixture pages on the real hosts, so the content scripts' matches are the real ones. */
export async function installSite(context: BrowserContext): Promise<Site> {
  const site: Site = { pages: new Map(), submits: 0, clicks: 0, challengeHits: 0, noisy: false }
  await context.route(
    (url) => (ATS_HOSTS as readonly string[]).includes(url.hostname),
    async (route) => {
      const u = new URL(route.request().url())
      if (u.pathname === '/__click') {
        site.clicks += 1
        return route.fulfill({ status: 204 })
      }
      if (u.pathname === '/__submit') {
        site.submits += 1
        return route.fulfill({ status: 200, contentType: 'text/html', body: confirmation(site.noisy) })
      }
      const hit = site.pages.get(u.hostname + u.pathname)
      if (!hit) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
      if (typeof hit !== 'string') return route.fulfill({ status: 302, headers: { location: hit.redirect } })
      return route.fulfill({ status: 200, contentType: 'text/html', body: hit })
    },
  )
  await context.route(
    (url) => url.hostname.endsWith('hcaptcha.com'),
    async (route) => {
      site.challengeHits += 1
      const script = route.request().resourceType() === 'script'
      return route.fulfill({
        status: 200,
        contentType: script ? 'text/javascript' : 'text/html',
        body: script ? '/* hcaptcha */' : CHALLENGE_FRAME,
      })
    },
  )
  return site
}

export async function launch(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
}

// A persistent context opens one blank page of its own. The pages a send opens are the others.
const INITIAL = new WeakMap<BrowserContext, Set<Page>>()
export const autoPages = (context: BrowserContext): Page[] => context.pages().filter((p) => !INITIAL.get(context)?.has(p))

export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Each helper runs a fixed function in the worker: the worker's CSP forbids eval,
// so a function cannot be passed in as text.

/** Fire the presence alarm now. The same listener runs as when the five-minute timer does. */
export async function tick(context: BrowserContext): Promise<void> {
  const w = await serviceWorker(context)
  await w.evaluate(() => (globalThis as any).chrome.alarms.create('cello-presence', { when: Date.now() + 100 }))
}

export async function alarmInfo(context: BrowserContext): Promise<{ name: string; periodInMinutes?: number } | null> {
  const w = await serviceWorker(context)
  return w.evaluate(() => (globalThis as any).chrome.alarms.get('cello-presence'))
}

export async function offscreenCount(context: BrowserContext): Promise<number> {
  const w = await serviceWorker(context)
  return w.evaluate(async () => (await (globalThis as any).chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)
}

export async function localGet(context: BrowserContext, key: string): Promise<unknown> {
  const w = await serviceWorker(context)
  return w.evaluate(async (k) => (await (globalThis as any).chrome.storage.local.get(k))[k], key)
}

export async function localSet(context: BrowserContext, values: Record<string, unknown>): Promise<void> {
  const w = await serviceWorker(context)
  await w.evaluate((v) => (globalThis as any).chrome.storage.local.set(v), values)
}

/** Connect the extension to the stub (a token, as the options page or Connect would store). */
export async function connect(context: BrowserContext, stub: Stub): Promise<void> {
  await localSet(context, { token: TOKEN })
  // A new token makes the first presence call straight away.
  await expect.poll(() => stub.calls('/api/fill/next').length).toBeGreaterThan(0)
  stub.requests.length = 0
}

export interface Fixtures {
  context: BrowserContext
  stub: Stub
  site: Site
}

const STUB = new Stub()
let stubStarted = false

export const test = base.extend<Fixtures>({
  stub: async ({}, use) => {
    if (!stubStarted) {
      await STUB.start()
      stubStarted = true
    }
    STUB.reset()
    await use(STUB)
  },
  context: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cello-ext-'))
    const context = await launch(dir)
    await serviceWorker(context)
    INITIAL.set(context, new Set(context.pages()))
    await use(context)
    await context.close().catch(() => undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  },
  site: async ({ context }, use) => {
    await use(await installSite(context))
  },
})

export { expect }
export type { Page }

export const GH_HOST: AutoHost = {
  host: 'job-boards.greenhouse.io',
  url_pattern: '^https://job-boards\\.greenhouse\\.io/(?<board>[^/]+)/jobs/(?<job>\\d+)',
  submit_labels: ['Submit application'],
  confirmation_patterns: ['thank you for applying'],
  confirmation_urls: [],
}

export const gh = (job: number | string): string => `https://job-boards.greenhouse.io/acme/jobs/${job}`

export const claim = (job: number | string, application = `app-${job}`): Claim => ({
  application,
  url: gh(job),
  company: 'Acme',
  hosts: [GH_HOST],
})
