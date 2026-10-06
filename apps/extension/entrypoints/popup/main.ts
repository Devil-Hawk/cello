import { browser } from 'wxt/browser'
import { version } from '../../lib/api'
import type { ExtensionStatus } from '../../lib/messages'
import { getLocal } from '../../lib/storage'
import { needsUpdate } from '../../lib/version'
import { icon, type IconName } from '../../ui/icons'
import { tokenCss } from '../../ui/tokens'

// The popup. One state at a time, one next step in each. The numbers come from
// Cello's own count (GET /api/extension/status through the worker); nothing is
// computed here.

const style = document.createElement('style')
style.textContent = tokenCss(':root')
document.head.append(style)

const app = document.getElementById('app') as HTMLElement

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (text) e.textContent = text
  if (cls) e.className = cls
  return e
}

function button(label: string, onClick: () => void | Promise<void>, opts: { primary?: boolean; icon?: IconName } = {}): HTMLButtonElement {
  const b = el('button', undefined, opts.primary ? 'primary' : undefined)
  b.type = 'button'
  if (opts.icon) b.append(icon(opts.icon))
  b.append(label)
  b.addEventListener('click', () => void onClick())
  return b
}

async function fillThisPage(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/fill-now.js'] })
  window.close()
}

const pause = (): Promise<void> => browser.runtime.sendMessage({ type: 'pause' }).then(render)
const resume = (): Promise<void> => browser.runtime.sendMessage({ type: 'resume' }).then(render)

function show(title: string, line: string, ...actions: HTMLElement[]): void {
  const row = el('div', undefined, 'row')
  row.append(...actions)
  app.replaceChildren(el('h1', title), el('p', line), ...(actions.length ? [row] : []))
}

async function render(): Promise<void> {
  const token = await getLocal('token')
  const presence = await getLocal('presence')

  if (!token) {
    show(
      'Cello is not connected',
      'In Cello, open Your search and choose Connect the extension. Or paste the token on the options page.',
      button('Open options', () => browser.runtime.openOptionsPage(), { primary: true }),
    )
    return
  }
  if (needsUpdate(version(), presence?.min_version)) {
    show('Update the Cello extension', 'This version is older than Cello allows. Load the new build from the install guide.')
    return
  }

  const status = (await browser.runtime.sendMessage({ type: 'status' }).catch(() => null)) as ExtensionStatus | null
  const paused = (await getLocal('paused')) === true || status?.paused === true

  if (paused) {
    show('Cello is paused', 'Nothing is sent until you resume.', button('Resume Cello', resume, { primary: true, icon: 'play' }))
    return
  }
  if (!status) {
    show('Cello could not be reached', 'Check your connection. Your token is saved.', button('Try again', render, { primary: true }))
    return
  }
  const fill = button('Fill this page', fillThisPage)
  if (status.send_for_me) {
    show(
      'Send for me is on.',
      `${status.sent_today} sent today, ${status.tries_today} of ${status.cap} tries used.`,
      button('Pause Cello', pause, { primary: true, icon: 'pause' }),
      fill,
    )
    return
  }
  fill.className = 'primary'
  show(
    'Send for me is off.',
    'Turn it on in Cello, in Your search. You can still fill a page from here.',
    fill,
    button('Pause Cello', pause, { icon: 'pause' }),
  )
}

void render()
