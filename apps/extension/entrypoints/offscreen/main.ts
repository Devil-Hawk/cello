import { browser } from 'wxt/browser'
import { askWorker, deviceCanRun, type DeviceNav, type LocalRequest } from '../../../web/lib/relay/local'

// The keep-alive port. The worker opens this document only while a send (or a relay
// job) is running and closes it after; a ping every 20 seconds keeps the worker up.
const port = browser.runtime.connect({ name: 'keepalive' })

function ping(): void {
  try {
    port.postMessage({ at: Date.now() })
  } catch {
    window.close()
    return
  }
  setTimeout(ping, 20_000)
}

port.onDisconnect.addListener(() => window.close())
ping()

// R1: a small model in this browser. The relay carrier asks over the runtime channel;
// the model runs in a worker made here, the first time a job needs it. Nothing else
// in the extension can reach it, and it sees only the messages the server built.
let worker: Worker | null = null

browser.runtime.onMessage.addListener((msg: { type?: string; request?: LocalRequest }, sender, respond) => {
  if (sender.id !== browser.runtime.id) return false
  if (msg?.type === 'relay-r1-check') {
    void deviceCanRun(navigator as unknown as DeviceNav).then((reason) => respond({ reason }))
    return true
  }
  if (msg?.type === 'relay-r1' && msg.request) {
    worker ??= new Worker(new URL('../../../web/lib/models/webllm.worker.ts', import.meta.url), { type: 'module' })
    askWorker(worker, msg.request).then(
      (text) => respond({ text }),
      (err: unknown) => respond({ error: err instanceof Error ? err.message.slice(0, 500) : 'The browser model failed.' }),
    )
    return true
  }
  return false
})
