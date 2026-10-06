import { browser } from 'wxt/browser'

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
