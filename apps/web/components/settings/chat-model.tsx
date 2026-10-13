'use client'

// The model each kind of work runs on: Chat, Research, Writing and Background work. Each has a way in (free models through
// OpenRouter, the person's own key, this computer), a model on it and an effort from Off up. Chat's is the default for new
// chats (the Chat picker still changes one chat); the others are the person's own for every chat, and follow Chat until chosen.
// A way in that is above the person's highest, or not set up, is greyed with the reason, as it is in Chat.
// POST /api/chat/settings: Chat sends {choice, as_default}, the others {role, choice} (null follows Chat again).

import { useCallback, useEffect, useState } from 'react'
import { EFFORT_WORDS } from '@/components/chat/model-picker'
import { Key } from '@/components/ui/key'
import type { SettingsView } from '@/lib/chat/settings'
import type { ModelChoice } from '@/lib/models/choice'
import { ROLE_LABELS, ROLES, type Role } from '@/lib/models/roles'

const WHAT: Record<Role, string> = {
  chat: 'Answers you and decides what to look up.',
  researcher: 'Reads the web and your sources about a company.',
  writer: 'Drafts notes, letters and tailored resumes.',
  worker: 'Work Cello does while you are away, such as tailoring a resume for an application.',
}

type PickableEffort = keyof typeof EFFORT_WORDS

function RoleModel({ role, view, onSaved }: { role: Role; view: SettingsView; onSaved: () => Promise<void> }) {
  const ran = view.roles[role]
  const [draft, setDraft] = useState<ModelChoice | null>(ran ? { rung: ran.rung, model: ran.model, effort: ran.effort } : null)
  const [note, setNote] = useState<string | null>(null)
  const rung = view.rungs.find((r) => r.rung === draft?.rung)
  const follows = view.followsChat.includes(role)
  // Deeper and Deepest are for models on the person's own key.
  const efforts = (Object.keys(EFFORT_WORDS) as PickableEffort[]).filter((e) => draft?.rung === 'R4' || (e !== 'xhigh' && e !== 'max'))
  const id = `role-${role}`

  async function send(choice: ModelChoice | null) {
    setNote(null)
    const body = role === 'chat' ? { choice, as_default: true } : { role, choice }
    const res = await fetch('/api/chat/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const answer = (await res.json().catch(() => ({}))) as { message?: string; fix?: string }
    setNote(res.ok ? (role === 'chat' ? 'Saved. New chats start on this.' : choice ? 'Saved.' : 'This follows Chat again.') : `${answer.message ?? 'Could not save that.'} ${answer.fix ?? ''}`.trim())
    if (res.ok) await onSaved()
  }

  return (
    <div role="group" className="space-y-2 border-t border-[var(--r-line)] pt-3" aria-labelledby={`${id}-name`}>
      <h4 id={`${id}-name`} className="r-name">{ROLE_LABELS[role]}</h4>
      <p className="r-meta">
        {WHAT[role]}
        {role !== 'chat' && follows && ' Follows Chat until you choose.'}
      </p>
      {view.rungs.map((r) => (
        <label key={r.rung} className="flex min-h-11 items-center gap-3">
          <input
            type="radio"
            name={`${id}-rung`}
            className="h-4 w-4 shrink-0"
            disabled={Boolean(r.why)}
            checked={draft?.rung === r.rung}
            onChange={() => setDraft({ rung: r.rung, model: r.models[0]?.id ?? draft?.model ?? '', effort: draft?.effort ?? 'medium' })}
          />
          <span className="r-body">{r.label}</span>
          {r.why && <span className="r-meta">{r.why}</span>}
        </label>
      ))}
      {rung && rung.models.length > 0 && (
        <label className="block space-y-1">
          <span className="r-meta">Model</span>
          <select className="r-field min-h-11" value={draft?.model} onChange={(e) => draft && setDraft({ ...draft, model: e.target.value })}>
            {rung.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft && (
        <label className="block space-y-1">
          <span className="r-meta">Effort</span>
          <select className="r-field min-h-11" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as ModelChoice['effort'] })}>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {EFFORT_WORDS[e]}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Key variant="raised" disabled={!draft?.model} onClick={() => send(draft)}>
          {role === 'chat' ? 'Save as the model for new chats' : `Save the ${ROLE_LABELS[role].toLowerCase()} model`}
        </Key>
        {role !== 'chat' && !follows && (
          <Key variant="ghost" onClick={() => send(null)}>
            Follow Chat again
          </Key>
        )}
      </div>
      {note && <p className="r-meta" role="status">{note}</p>}
    </div>
  )
}

export function ChatModel() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Bumped after a save so each row starts again from what is stored.
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    const res = await fetch('/api/chat/settings', { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) return setNote('Could not read your models. Try again.')
    setView((await res.json()) as SettingsView)
    setVersion((v) => v + 1)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!view) return note ? <p className="r-meta" role="alert">{note}</p> : <p className="r-meta">Reading.</p>
  return (
    <div className="space-y-3">
      <h3 className="r-name">Model for each kind of work</h3>
      {ROLES.map((role) => (
        <RoleModel key={`${role}-${version}`} role={role} view={view} onSaved={load} />
      ))}
    </div>
  )
}
