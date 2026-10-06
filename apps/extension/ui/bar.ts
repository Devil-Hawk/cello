// The page bar, the in-page Fill button and the Draft this buttons. Each lives in
// its own closed-off shadow root so the page's styles and scripts cannot reach it,
// and none of it is a form control the page could count as a submit button.
// Colours come from the design tokens (ui/tokens.ts), light and dark.

import { icon, type IconName } from './icons'
import { tokenCss } from './tokens'

export interface BarAction {
  label: string
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  icon?: IconName
}

export interface BarState {
  text: string
  actions?: BarAction[]
  /** info: working. warn: handed back to the person. done: finished. */
  tone?: 'info' | 'warn' | 'done'
}

const BASE = `
  :host { all: initial; }
  ${tokenCss(':host')}
  * { box-sizing: border-box; }
  button { font: inherit; cursor: pointer; }
`

const BAR_CSS = `
  .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; min-height: 44px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 4px 16px;
    font: 14px/1.4 system-ui, sans-serif; background: var(--surface); color: var(--ink);
    border-bottom: 1px solid var(--ink3); }
  .mark { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; background: var(--petrol); }
  .warn .mark { background: var(--stop); }
  .glyph { flex: 0 0 auto; display: flex; color: var(--ok); }
  .text { flex: 1 1 12rem; }
  .actions { display: flex; gap: 8px; flex: 0 0 auto; }
  button { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; min-width: 44px; padding: 0 14px;
    border-radius: 6px; border: 1px solid var(--ink3); background: transparent; color: var(--ink); }
  button.primary { background: var(--copper-text); color: var(--btn-fg); border-color: var(--copper-text); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--petrol-text); outline-offset: 2px; }
`

const BUTTON_CSS = `
  button { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; min-height: 44px; min-width: 44px;
    padding: 0 16px; border-radius: 22px; border: 1px solid var(--copper-text); background: var(--copper-text);
    color: var(--btn-fg); font: 600 14px system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  button:focus-visible { outline: 2px solid var(--petrol-text); outline-offset: 2px; }
`

function host(tag: string, css: string): { host: HTMLElement; root: ShadowRoot } {
  const el = document.createElement(tag)
  const root = el.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = BASE + css
  root.append(style)
  return { host: el, root }
}

export interface Bar {
  show(state: BarState): void
  hide(): void
}

export function mountBar(): Bar {
  let mounted: { host: HTMLElement; root: ShadowRoot } | null = null
  let body: HTMLElement | null = null
  return {
    show(state) {
      if (!mounted) {
        mounted = host('cello-bar', BAR_CSS)
        body = document.createElement('div')
        mounted.root.append(body)
        document.documentElement.append(mounted.host)
      }
      const b = body as HTMLElement
      const tone = state.tone ?? 'info'
      b.className = `bar ${tone}`
      b.replaceChildren()
      b.setAttribute('role', 'status')
      const lead = document.createElement('span')
      if (tone === 'done') {
        lead.className = 'glyph'
        lead.append(icon('check'))
      } else {
        lead.className = 'mark'
      }
      const t = document.createElement('div')
      t.className = 'text'
      t.textContent = state.text
      const actions = document.createElement('div')
      actions.className = 'actions'
      for (const a of state.actions ?? []) {
        const btn = document.createElement('button')
        btn.type = 'button'
        if (a.icon) btn.append(icon(a.icon, 16))
        btn.append(a.label)
        if (a.primary) btn.className = 'primary'
        btn.disabled = !!a.disabled
        btn.addEventListener('click', (e) => {
          if (e.isTrusted) a.onClick()
        })
        actions.append(btn)
      }
      b.append(lead, t, actions)
    },
    hide() {
      mounted?.host.remove()
      mounted = null
      body = null
    },
  }
}

/** The in-page button. A click the page's own script made (isTrusted false) is ignored. */
export function mountFillButton(onClick: () => void): () => void {
  const m = host('cello-fill-button', BUTTON_CSS)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Fill with Cello'
  btn.addEventListener('click', (e) => {
    if (e.isTrusted) onClick()
  })
  m.root.append(btn)
  document.documentElement.append(m.host)
  return () => m.host.remove()
}

const DRAFT_CSS = `
  button { min-height: 44px; min-width: 44px; margin: 4px 0; padding: 0 14px; border-radius: 6px;
    border: 1px solid var(--ink3); background: var(--surface); color: var(--ink); font: 600 14px system-ui, sans-serif; }
  button:focus-visible { outline: 2px solid var(--petrol-text); outline-offset: 2px; }
`

/** "Draft this" after a motivation field. Returns a remover. */
export function mountDraftButton(after: HTMLElement, onClick: () => void): () => void {
  const m = host('cello-draft', DRAFT_CSS)
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Draft this'
  btn.addEventListener('click', (e) => {
    if (e.isTrusted) onClick()
  })
  m.root.append(btn)
  after.insertAdjacentElement('afterend', m.host)
  return () => m.host.remove()
}
