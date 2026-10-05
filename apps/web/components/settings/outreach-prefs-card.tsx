'use client'

// The outreach policy: how many emails a day may leave, how long to wait before
// the one follow-up, and whether sending needs a click. The send route, the
// queue banner and the follow-up window all read these values; this card is the
// only place they can be changed.

import { useEffect, useState } from 'react'
import { Loader2, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface Prefs {
  autoSend: boolean
  dailyCap: number
  followUpDays: number
}

export function OutreachPrefsCard({ onStatus }: { onStatus: (status: 'success' | 'error', message: string) => void }) {
  const [saved, setSaved] = useState<Prefs | null>(null)
  const [dailyCap, setDailyCap] = useState('')
  const [followUpDays, setFollowUpDays] = useState('')
  const [autoSend, setAutoSend] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/settings/outreach')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { prefs: Prefs }) => {
        if (!live) return
        setSaved(d.prefs)
        setDailyCap(String(d.prefs.dailyCap))
        setFollowUpDays(String(d.prefs.followUpDays))
        setAutoSend(d.prefs.autoSend)
      })
      .catch(() => live && setLoadFailed(true))
    return () => {
      live = false
    }
  }, [])

  const dirty =
    saved !== null &&
    (autoSend !== saved.autoSend || dailyCap !== String(saved.dailyCap) || followUpDays !== String(saved.followUpDays))

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSend, dailyCap: Number(dailyCap), followUpDays: Number(followUpDays) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        onStatus('error', data.message ?? data.error ?? 'Could not save outreach settings')
      } else {
        setSaved(data.prefs)
        onStatus('success', 'Outreach settings saved')
      }
    } catch {
      onStatus('error', 'Could not save outreach settings')
    }
    setSaving(false)
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-body font-semibold text-foreground">Outreach limits</h3>
      </div>
      <p className="mt-1 text-caption text-muted-foreground">
        Applies to cold emails sent from the queue. Every email is still yours to review first.
      </p>

      {loadFailed ? (
        <p className="mt-3 text-caption text-pipeline-rejected">Could not load your outreach settings. Reload to try again.</p>
      ) : saved === null ? (
        <div className="mt-3 flex items-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-caption font-medium text-foreground">Emails per day, at most</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                value={dailyCap}
                onChange={(e) => setDailyCap(e.target.value)}
                className="mt-1"
              />
              <span className="mt-1 block text-caption text-muted-foreground">1 to 50. Counted per UTC day.</span>
            </label>
            <label className="block">
              <span className="text-caption font-medium text-foreground">Days before a follow-up</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={60}
                value={followUpDays}
                onChange={(e) => setFollowUpDays(e.target.value)}
                className="mt-1"
              />
              <span className="mt-1 block text-caption text-muted-foreground">
                1 to 60. One follow-up per email, only if there is no reply.
              </span>
            </label>
          </div>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-accent"
            />
            <span>
              <span className="text-caption font-medium text-foreground">Let drafts be sent without an approval step</span>
              <span className="block text-caption text-muted-foreground">
                Off by default. When on, a draft you send is no longer held for a separate approval, and the
                queue banner says so. Nothing sends by itself in the background.
              </span>
            </span>
          </label>

          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save outreach settings
          </Button>
        </div>
      )}
    </Card>
  )
}
