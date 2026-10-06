import { defineConfig } from 'wxt'

// The Cello server this build talks to. Read at build time (the CI test build
// points it at the stub server on loopback). Match patterns carry no port.
const origin = (process.env.WXT_CELLO_ORIGIN ?? 'https://cello-two.vercel.app').replace(/\/$/, '')
const host = new URL(origin)
const celloPattern = `${host.protocol}//${host.hostname}/*`

export default defineConfig({
  zip: { name: 'cello-extension' },
  manifest: {
    name: 'Cello',
    description: "Fills job applications in your own browser. You click the employer's button.",
    // Section 7 of the blueprint, exactly. activeTab and scripting run the fill on
    // the person's click; storage holds the token; tabs and alarms are the send
    // timer and its window; offscreen keeps the worker alive during a send.
    permissions: ['activeTab', 'scripting', 'storage', 'tabs', 'alarms', 'offscreen'],
    host_permissions: [
      'https://boards.greenhouse.io/*',
      'https://job-boards.greenhouse.io/*',
      'https://jobs.lever.co/*',
      'https://jobs.ashbyhq.com/*',
      celloPattern,
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    // Only the Cello origin may hand the extension its token.
    externally_connectable: { matches: [celloPattern] },
    icons: { 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_title: 'Cello' },
    minimum_chrome_version: '120',
  },
})
