import { ROUTES } from '../lib/fill-contract'
import type { DraftResponse, SessionResponse } from '../lib/fill-contract'
import { send } from '../lib/messages'
import { mountBar, mountDraftButton } from '../ui/bar'
import type { Bar } from '../ui/bar'
import { matchConfirmation } from './confirm-text'
import { BLOCKED_LINE, detectBlockers } from './detect'
import { fillField } from './fill'
import { holdSubmits } from './guard'
import { readFields, toInfo } from './read-fields'
import { readBack } from './readback'
import { api, applySession, report, snapshot } from './state'
import type { FilledState } from './state'
import { watchPage } from './watch'

// The person's own fill: they clicked, Cello fills what it knows, they send.

let busy = false

function problem(status: number): string {
  if (status === 401 || status === 403) return 'Connect the extension to Cello first. Open its options page.'
  if (status === 0) return 'Cello could not be reached.'
  return 'Cello could not read this page.'
}

export async function manualFill(): Promise<void> {
  if (busy) return
  busy = true
  const bar = mountBar()
  const release = holdSubmits()
  let filled: FilledState | null = null
  try {
    bar.show({ text: 'Cello is reading this form.' })
    const blocker = detectBlockers(document, false)
    if (blocker) {
      void report({ phase: 'blocked', url: location.href, cause: blocker.cause })
      bar.show({ text: BLOCKED_LINE, tone: 'warn' })
      return
    }
    const fields = readFields()
    const r = await api<SessionResponse>(ROUTES.session, { url: location.href, fields: toInfo(fields) })
    if (!r.ok) {
      bar.show({ text: problem(r.status), tone: 'warn' })
      return
    }
    const res = r.data
    if (res.status !== 'ok') {
      bar.show({ text: res.message, tone: 'warn' })
      return
    }
    filled = await applySession(res, fields)
    if (filled.fileMissing) filled.unknown.push('resume')
    offerDrafts(filled, res.drafts ?? [])
    const total = fields.filter((f) => f.kind !== 'password').length
    void report({
      phase: 'filled',
      application: filled.application,
      filled: filled.filled.length,
      total,
      unknown: filled.unknown,
    })
    const need = total - filled.filled.length
    bar.show({
      text: `Filled ${filled.filled.length} of ${total} fields.${need > 0 ? ` ${need} need you on the page.` : ''}`,
      actions: [{ label: 'Send next', onClick: () => void sendNext(bar) }],
    })
  } finally {
    release()
    busy = false
  }
  if (filled) armSubmit(filled, bar)
}

function offerDrafts(state: FilledState, keys: string[]): void {
  for (const key of keys) {
    const f = state.fields.find((x) => x.key === key)
    const el = f?.els[0]
    if (!f || !el || state.filled.includes(key)) continue
    mountDraftButton(el, () => {
      void (async () => {
        const r = await api<DraftResponse>(ROUTES.draft, { application: state.application, field: key })
        if (r.ok && r.data.text) fillField(f, r.data.text)
      })()
    })
  }
}

async function sendNext(bar: Bar): Promise<void> {
  const r = await send<{ opened: boolean }>({ type: 'next' })
  if (!r?.opened) bar.show({ text: 'No other application is ready.', actions: [] })
}

/** After the fill the hold is off: the person's own submit is read back and reported. */
function armSubmit(state: FilledState, bar: Bar): void {
  const onSubmit = (e: Event): void => {
    const form = e.target
    if (!(form instanceof HTMLFormElement) || !state.fields.some((f) => f.form === form)) return
    if (!form.checkValidity()) return
    window.removeEventListener('submit', onSubmit, true)
    // ponytail: a submit the page's own script then refuses is still reported; the
    // confirmation, not this report, is what the server trusts. Wait for the page's
    // verdict only if false reports show up in practice.
    const values = readBack(snapshot(state, form))
    void send({ type: 'pending', pending: { application: state.application, auto: false, since: Date.now() } })
    void report({ phase: 'submitted', application: state.application, values, url: location.href })
    void watchManualConfirmation(state.application, bar)
  }
  window.addEventListener('submit', onSubmit, true)
}

/** On this page or the next: capture the confirmation text, the address and one picture. */
export async function watchManualConfirmation(application: string, bar: Bar = mountBar()): Promise<void> {
  const hit = await watchPage(() => matchConfirmation(document.body?.innerText ?? ''), 60_000)
  if (!hit) {
    void send({ type: 'pending', pending: null })
    return
  }
  const screenshot = await send<string | null>({ type: 'screenshot' })
  void report({
    phase: 'confirmation',
    application,
    text: hit,
    url: location.href,
    ...(screenshot ? { screenshot } : {}),
  })
  void send({ type: 'pending', pending: null })
  bar.show({ text: 'Cello saved the confirmation.', actions: [{ label: 'Send next', onClick: () => void sendNext(bar) }] })
}
