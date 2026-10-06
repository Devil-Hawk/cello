'use client'

// The follow-up reminder rule, editable where it applies: for everyone (Network's menu) or for one person
// (their page: use my default, their own two numbers, never remind me, snooze until a date).

import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { callCommand } from '@/lib/network/client'

interface Global {
  on: boolean
  after_yours_bd: number
  after_theirs_d: number
}
interface Own {
  after_yours_bd?: number
  after_theirs_d?: number
  off?: boolean
  snooze_until?: string | null
}

const DOOR = '/api/network'

export function RuleEditor({ contactId, global, own, onSaved }: { contactId?: string; global: Global; own?: Own | null; onSaved?: () => void }) {
  const [yours, setYours] = useState(String(own?.after_yours_bd ?? global.after_yours_bd))
  const [theirs, setTheirs] = useState(String(own?.after_theirs_d ?? global.after_theirs_d))
  const [on, setOn] = useState(global.on)
  const [snooze, setSnooze] = useState(own?.snooze_until ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(rule: Record<string, unknown> | null) {
    setBusy(true)
    setMsg(null)
    try {
      await callCommand(DOOR, 'network.set_rule', { ...(contactId ? { contact_id: contactId } : {}), rule })
      setMsg('Saved.')
      onSaved?.()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  const numbers = { after_yours_bd: Number(yours), after_theirs_d: Number(theirs) }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4">
        <label className="block">
          <span className="r-meta block">After your message, business days (1 to 30)</span>
          <input className="r-field min-h-11 w-28" type="number" min={1} max={30} value={yours} onChange={(e) => setYours(e.target.value)} />
        </label>
        <label className="block">
          <span className="r-meta block">After their reply, days (1 to 14)</span>
          <input className="r-field min-h-11 w-28" type="number" min={1} max={14} value={theirs} onChange={(e) => setTheirs(e.target.value)} />
        </label>
      </div>
      {!contactId && (
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span className="r-body">Remind me to follow up</span>
        </label>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Key disabled={busy} onClick={() => save(contactId ? numbers : { ...numbers, on })}>Save</Key>
        {contactId && (
          <>
            <Key variant="raised" disabled={busy} onClick={() => save(null)}>Use my default</Key>
            <Key variant="raised" disabled={busy} onClick={() => save({ off: true })}>Never remind me</Key>
          </>
        )}
      </div>
      {contactId && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="r-meta block">Snooze until</span>
            <input className="r-field min-h-11" type="date" value={snooze} onChange={(e) => setSnooze(e.target.value)} />
          </label>
          <Key variant="raised" disabled={busy || !snooze} onClick={() => save({ snooze_until: snooze })}>Snooze</Key>
        </div>
      )}
      {msg && <p className="r-meta" role="status">{msg}</p>}
    </div>
  )
}
