'use client'

// Ask once, on this device, whether Cello may send notifications. Nothing is asked until the person
// presses the button (browsers refuse a prompt without a click), and the sentence is plain when the
// server cannot send them yet.

import { useEffect, useState } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

type State =
  | { kind: 'loading' }
  | { kind: 'off'; sentence: string }
  | { kind: 'unsupported' }
  | { kind: 'ready'; publicKey: string }
  | { kind: 'on' }
  | { kind: 'blocked' }
  | { kind: 'error' }

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function PushPrompt() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return live && setState({ kind: 'unsupported' })
        const res = await fetch('/api/notifications/push')
        const body = (await res.json()) as { enabled?: boolean; publicKey?: string; sentence?: string }
        if (!live) return
        if (!body.enabled || !body.publicKey) return setState({ kind: 'off', sentence: body.sentence ?? 'Notifications on this device are not set up on this server.' })
        if (Notification.permission === 'denied') return setState({ kind: 'blocked' })
        const reg = await navigator.serviceWorker.getRegistration('/push-sw.js')
        const sub = await reg?.pushManager.getSubscription()
        setState(sub && Notification.permission === 'granted' ? { kind: 'on' } : { kind: 'ready', publicKey: body.publicKey })
      } catch {
        if (live) setState({ kind: 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [])

  async function turnOn(publicKey: string) {
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return setState({ kind: 'blocked' })
      const reg = await navigator.serviceWorker.register('/push-sw.js')
      await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
      const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      const res = await fetch('/api/notifications/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) })
      setState(res.ok ? { kind: 'on' } : { kind: 'error' })
    } catch {
      setState({ kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading' || state.kind === 'unsupported') return null
  if (state.kind === 'off') return <p className="text-sm text-muted-foreground">{state.sentence}</p>
  if (state.kind === 'on') return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Bell className="h-4 w-4" aria-hidden /> Notifications are on for this device.</p>
  if (state.kind === 'blocked') return <p className="flex items-center gap-2 text-sm text-muted-foreground"><BellOff className="h-4 w-4" aria-hidden /> Notifications are blocked in this browser. Allow them in the site settings to turn them on.</p>
  if (state.kind === 'error') return <p className="text-sm text-muted-foreground">Could not turn notifications on. Try again later.</p>
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">Get a notification when an employer writes or an application needs you.</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => turnOn(state.publicKey)}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Bell className="mr-2 h-4 w-4" aria-hidden />}
        Turn on notifications
      </Button>
    </div>
  )
}
