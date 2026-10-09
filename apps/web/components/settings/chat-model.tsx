'use client'

// The model Chat starts on: the way in (free models through OpenRouter, the person's own key, this computer) and the model on
// it. Saved as the default for new chats (POST /api/chat/settings with as_default); the Chat picker still changes one chat.
// A way in that is above the person's highest, or not set up, is greyed with the reason, as it is in Chat.

import { useCallback, useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import type { SettingsView } from '@/lib/chat/settings'
import type { ModelChoice } from '@/lib/models/choice'

export function ChatModel() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [draft, setDraft] = useState<ModelChoice | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/chat/settings', { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) return setNote('Could not read the Chat model. Try again.')
    const v = (await res.json()) as SettingsView
    setView(v)
    setDraft(v.ran ? { rung: v.ran.rung, model: v.ran.model, effort: v.ran.effort } : null)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!view) return note ? <p className="r-meta" role="alert">{note}</p> : <p className="r-meta">Reading.</p>
  const rung = view.rungs.find((r) => r.rung === draft?.rung)

  async function save() {
    if (!draft) return
    setNote(null)
    const res = await fetch('/api/chat/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: draft, as_default: true }) })
    const body = (await res.json().catch(() => ({}))) as { message?: string; fix?: string }
    setNote(res.ok ? 'Saved. New chats start on this.' : `${body.message ?? 'Could not save that.'} ${body.fix ?? ''}`.trim())
    if (res.ok) await load()
  }

  return (
    <div className="space-y-3">
      <h3 className="r-name">Model for Chat</h3>
      <fieldset className="space-y-1">
        <legend className="r-meta">Way in</legend>
        {view.rungs.map((r) => (
          <label key={r.rung} className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name="chat-rung"
              className="h-4 w-4"
              disabled={Boolean(r.why)}
              checked={draft?.rung === r.rung}
              onChange={() => setDraft({ rung: r.rung, model: r.models[0]?.id ?? draft?.model ?? '', effort: draft?.effort ?? 'medium' })}
            />
            <span className="r-body">{r.label}</span>
            {r.why && <span className="r-meta">{r.why}</span>}
          </label>
        ))}
      </fieldset>
      {rung && rung.models.length > 0 && (
        <label className="block space-y-1">
          <span className="r-meta">Model</span>
          <select className="r-field" value={draft?.model} onChange={(e) => draft && setDraft({ ...draft, model: e.target.value })}>
            {rung.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <Key variant="raised" disabled={!draft?.model} onClick={save}>
        Save as the model for new chats
      </Key>
      {note && <p className="r-meta" role="status">{note}</p>}
    </div>
  )
}
