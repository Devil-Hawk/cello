import { browser } from 'wxt/browser'
import { version } from '../../lib/api'
import { getLocal } from '../../lib/storage'
import { needsUpdate } from '../../lib/version'

// The plain popup. PG10 rebuilds it on the design tokens with the numbers from
// Cello's own count; this one says whether the extension is connected and offers
// the two things a person does from the toolbar: fill this page, pause Cello.

const app = document.getElementById('app') as HTMLElement

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (text) e.textContent = text
  if (cls) e.className = cls
  return e
}

function button(label: string, onClick: () => void | Promise<void>, primary = false): HTMLButtonElement {
  const b = el('button', label, primary ? 'primary' : undefined)
  b.type = 'button'
  b.addEventListener('click', () => void onClick())
  return b
}

async function fillThisPage(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/fill-now.js'] })
  window.close()
}

async function render(): Promise<void> {
  const token = await getLocal('token')
  const paused = (await getLocal('paused')) === true
  const presence = await getLocal('presence')
  app.replaceChildren()

  if (!token) {
    app.append(
      el('h1', 'Cello is not connected'),
      el('p', 'In Cello, open Your search and choose Connect the extension. Or paste the token on the options page.'),
      button('Open options', () => browser.runtime.openOptionsPage(), true),
    )
    return
  }
  if (needsUpdate(version(), presence?.min_version)) {
    app.append(
      el('h1', 'Update the Cello extension'),
      el('p', 'This version is older than Cello allows. Load the new build from the install guide.'),
    )
    return
  }
  if (paused) {
    app.append(
      el('h1', 'Cello is paused'),
      el('p', 'Nothing will be sent until you resume.'),
      button(
        'Resume Cello',
        async () => {
          await browser.runtime.sendMessage({ type: 'resume' })
          await render()
        },
        true,
      ),
    )
    return
  }
  const row = el('div', undefined, 'row')
  row.append(
    button('Fill this page', fillThisPage, true),
    button('Pause Cello', async () => {
      await browser.runtime.sendMessage({ type: 'pause' })
      await render()
    }),
  )
  app.append(
    el('h1', 'Cello is connected'),
    el('p', presence?.at ? `Cello last heard from this browser at ${new Date(presence.at).toLocaleTimeString()}.` : 'Waiting for the first check.'),
    row,
  )
}

void render()
