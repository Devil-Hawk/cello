'use client'

// Your browser (blueprint 4.11, section 7): the extension, when it was last seen, Send for me with its daily limit and
// today's count, and Disconnect. Send for me is off until the person has read its sentence and turned it on here.
// Every number comes from the token row and extension_status() through /api/settings/browser.

import { useCallback, useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import { ago } from '@/lib/network/format'

export interface BrowserState {
  connected: boolean
  lastSeen: string | null
  sendForMe: boolean
  paused: boolean
  cap: number
  sentToday: number
  triesToday: number
}

export const SEND_SENTENCE =
  "Cello sends an application only from your own browser: when you click the employer's button, or, if you turn on Send for me, within your rule and daily limit. It never gets past a login or a human check for you."
export const SEND_RULE =
  'Send for me sends Ready applications you chose that are Strong at companies you follow, with a resume you approved and answers you gave yourself. Your computer and Chrome must be open. Pause Cello stops it at once.'

export function BrowserPanel({
  state,
  token,
  note,
  busy,
  onConnect,
  onDisconnect,
  onSend,
}: {
  state: BrowserState
  /** A token just made, shown once. */
  token?: string | null
  note?: string | null
  busy?: boolean
  onConnect: () => void
  onDisconnect: () => void
  onSend: (a: { on: boolean; perDay: number; agreed: boolean }) => void
}) {
  const [agreed, setAgreed] = useState(false)
  const [perDay, setPerDay] = useState(String(state.cap))
  return (
    <div className="space-y-4">
      {state.paused && <p className="r-body">Cello is paused, so nothing is prepared or sent.</p>}
      {!state.connected ? (
        <div className="space-y-2">
          <p className="r-body">Your browser is not connected. Cello fills applications in your own browser with its extension, and you click the employer&apos;s button.</p>
          <Key onClick={onConnect} disabled={busy}>Connect my browser</Key>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="r-body">
            The extension is connected. {state.lastSeen ? `Last seen ${ago(state.lastSeen)}.` : 'It has not checked in yet.'}
          </p>
          <div className="space-y-2">
            <h3 className="r-name">Send for me</h3>
            <p className="r-body">{SEND_SENTENCE}</p>
            <p className="r-meta">{SEND_RULE}</p>
            {state.sendForMe ? (
              <div className="space-y-2">
                <p className="r-body">Send for me is on. {state.sentToday} sent today, {state.triesToday} tried, limit {state.cap} a day.</p>
                <Key variant="raised" disabled={busy} onClick={() => onSend({ on: false, perDay: state.cap, agreed: true })}>Turn off Send for me</Key>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" className="h-4 w-4" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span className="r-body">I have read this</span>
                </label>
                <label className="block">
                  <span className="r-meta block">Daily limit, 1 to 10</span>
                  <input type="number" inputMode="numeric" min={1} max={10} className="r-field min-h-11 w-28" value={perDay} onChange={(e) => setPerDay(e.target.value)} />
                </label>
                <Key disabled={busy || !agreed} onClick={() => onSend({ on: true, perDay: Math.min(10, Math.max(1, Number(perDay) || 3)), agreed })}>Turn on Send for me</Key>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Key variant="raised" disabled={busy} onClick={onConnect}>Make a new token</Key>
            <Key variant="ghost" disabled={busy} onClick={onDisconnect}>Disconnect</Key>
          </div>
        </div>
      )}
      {token && (
        <div className="space-y-1">
          <p className="r-body">Paste this into the extension&apos;s options. It is shown once, and it replaces the old one.</p>
          <input readOnly aria-label="Extension token" className="r-field min-h-11 w-full font-mono" value={token} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {note && <p className="r-meta" role="status">{note}</p>}
    </div>
  )
}

export function YourBrowser() {
  const [state, setState] = useState<BrowserState | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/browser')
      if (!res.ok) throw new Error(String(res.status))
      setState((await res.json()) as BrowserState)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function act(fn: () => Promise<Response>, done: string) {
    setBusy(true)
    setNote(null)
    try {
      const res = await fn()
      const body = (await res.json().catch(() => ({}))) as { error?: string; token?: string }
      if (!res.ok) throw new Error(body.error ?? 'Could not do that. Nothing changed.')
      if (body.token) setToken(body.token)
      else setToken(null)
      setNote(done)
      await load()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not do that. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  if (failed) return <p className="r-body" role="alert">Could not read your browser. Reload to try again.</p>
  if (!state) return <p className="r-meta">Reading.</p>
  return (
    <BrowserPanel
      state={state}
      token={token}
      note={note}
      busy={busy}
      onConnect={() => act(() => fetch('/api/fill/token', { method: 'POST' }), 'Connected once you paste the token.')}
      onDisconnect={() => act(() => fetch('/api/settings/browser', { method: 'DELETE' }), 'Disconnected. Send for me is off.')}
      onSend={(a) => act(() => fetch('/api/settings/pipeline', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send: { on: a.on, perDay: a.perDay, agreed: a.agreed } }) }), a.on ? 'Send for me is on.' : 'Send for me is off.')}
    />
  )
}
