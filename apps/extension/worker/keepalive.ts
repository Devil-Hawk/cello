import { browser } from 'wxt/browser'

// A manifest-v3 worker is stopped after a short idle. During a send (and, later, a
// relay job) an offscreen document holds a port to the worker and pings it, which
// keeps the worker running. The document exists only while something needs it.

let holders = 0

type Reasons = Parameters<typeof browser.offscreen.createDocument>[0]['reasons']

async function exists(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as never] })
  return contexts.length > 0
}

export async function startKeepAlive(): Promise<void> {
  holders += 1
  if (await exists()) return
  await browser.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'] as unknown as Reasons,
    justification: 'Keeps the extension running while Cello fills and sends an application.',
  })
}

export async function stopKeepAlive(): Promise<void> {
  holders = Math.max(0, holders - 1)
  if (holders > 0) return
  if (await exists()) await browser.offscreen.closeDocument().catch(() => undefined)
}

/** The offscreen document's port: any message resets the worker's idle timer. */
export function listenKeepAlive(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepalive') port.onMessage.addListener(() => undefined)
  })
}
