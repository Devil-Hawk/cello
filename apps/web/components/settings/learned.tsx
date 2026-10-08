'use client'

// What Cello learned (blueprint 9): proposals first, each with its evidence and the one thing it would change,
// then what is on, grouped by what it changes, then what is turned off. Keep acts where it says; Not right
// deletes. A statement from a count is code's; a read carries its quote; an edit makes it the person's own.

import { useCallback, useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import { callCommand } from '@/lib/network/client'
import type { Learning, LearningEffect } from '@/lib/learning/types'

const DOOR = '/api/settings/learned'

/** What each effect changes, in the person's words. */
const CHANGES: Record<LearningEffect, string> = {
  'rank.want': 'Which roles come first',
  'rank.type': 'Which roles come first',
  'type.synonym': 'Titles you count as yours',
  'rank.fresh': 'Which roles come first',
  'prepare.order': 'What Cello prepares first',
  'resume.version': 'Which resume goes to which role',
  'chance.gap': 'How Cello reads your chances',
  'draft.style': 'How Cello writes for you',
  'answer.ask': 'What Cello asks you',
  'search.propose': 'Suggestions for your search',
  'nudge.rule': 'When Cello reminds you to follow up',
  none: 'Kept as a note',
}

const SOURCE = { code: 'Counted by Cello', model: "Cello's read", person: 'Yours' } as const

function Row({ l, onDone }: { l: Learning; onDone: () => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(l.statement)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function act(command: string, input: Record<string, unknown> = {}) {
    setBusy(true)
    setError(null)
    try {
      await callCommand(DOOR, command, { id: l.id, ...input })
      setEditing(false)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="py-3">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`edit-${l.id}`}>Edit what Cello learned</label>
          <input id={`edit-${l.id}`} className="r-field min-h-11 min-w-0 flex-1 basis-64" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
          <Key disabled={busy || !text.trim()} onClick={() => act('learned.edit', { statement: text })}>Save</Key>
          <Key variant="ghost" onClick={() => setEditing(false)}>Cancel</Key>
        </div>
      ) : (
        <p className="r-name">{l.statement}</p>
      )}
      <p className="r-meta mt-1">
        {SOURCE[l.origin]}
        {l.n > 0 ? `, from ${l.n} ${l.n === 1 ? 'thing' : 'things'}` : ''}
        {l.quote ? `. "${l.quote}"` : ''}
      </p>
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {l.status === 'proposed' && (
            <>
              <Key disabled={busy} onClick={() => act('learned.keep')}>Keep</Key>
              <Key variant="raised" disabled={busy} onClick={() => act('learned.not_right')}>Not right</Key>
            </>
          )}
          {l.status === 'active' && <Key variant="raised" disabled={busy} onClick={() => act('learned.off')}>Turn off</Key>}
          {l.status === 'off' && <Key variant="raised" disabled={busy} onClick={() => act('learned.on')}>Turn on</Key>}
          {l.origin !== 'code' && <Key variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</Key>}
          {l.status !== 'proposed' && <Key variant="ghost" disabled={busy} onClick={() => act('learned.delete')}>Delete</Key>}
        </div>
      )}
      {error && <p className="r-meta mt-1" role="alert">{error}</p>}
    </li>
  )
}

export function Learned() {
  const [items, setItems] = useState<Learning[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await callCommand<{ ok: boolean; items?: Learning[]; sentence?: string }>(DOOR, 'learned.list', {})
      if (r.ok) {
        setItems(r.items ?? [])
        setProblem(null)
      } else {
        setProblem(r.sentence ?? 'Cello could not read what it learned.')
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Cello could not read what it learned.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const proposed = (items ?? []).filter((l) => l.status === 'proposed')
  const active = (items ?? []).filter((l) => l.status === 'active')
  const off = (items ?? []).filter((l) => l.status === 'off')
  const groups = [...new Set(active.map((l) => CHANGES[l.effect]))]

  return (
    <section aria-labelledby="learned-heading" className="r-sheet p-6">
      <h2 id="learned-heading" className="r-title">What Cello learned</h2>
      {problem && <p className="r-body mt-3" role="status">{problem}</p>}
      {items === null && !problem && <p className="r-meta mt-3">Reading.</p>}
      {items?.length === 0 && <p className="r-body mt-3">Cello has not learned anything yet. React to a few roles, and it starts with those.</p>}
      {proposed.length > 0 && (
        <div className="mt-4">
          <h3 className="r-meta">Waiting for you</h3>
          <ul className="divide-y divide-[var(--r-line)]">{proposed.map((l) => <Row key={l.id} l={l} onDone={load} />)}</ul>
        </div>
      )}
      {groups.map((g) => (
        <div key={g} className="mt-4">
          <h3 className="r-meta">{g}</h3>
          <ul className="divide-y divide-[var(--r-line)]">{active.filter((l) => CHANGES[l.effect] === g).map((l) => <Row key={l.id} l={l} onDone={load} />)}</ul>
        </div>
      ))}
      {off.length > 0 && (
        <details className="mt-4">
          <summary className="r-meta min-h-11 cursor-pointer">Turned off ({off.length})</summary>
          <ul className="divide-y divide-[var(--r-line)]">{off.map((l) => <Row key={l.id} l={l} onDone={load} />)}</ul>
        </details>
      )}
    </section>
  )
}
