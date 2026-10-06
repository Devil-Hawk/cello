'use client'

// The part of an application's record that lists what was made for it and the chats about it, whichever page made
// them. Rendered by the record's "after acting" slot (components/roles/after) once that slot exists; until then this is
// exported and not mounted. Both lists are read from rows through /api/chat/made, and each opens in Chat.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { typeWord } from '@/components/chat/side-panel'

export interface MadeItem {
  id: string
  type: string
  title: string
  updated_at: string
}
export interface ChatItem {
  id: string
  title: string
}

/** The lists as drawn: nothing at all when there is nothing to say. */
export function ApplicationMadeView({ made, chats }: { made: MadeItem[]; chats: ChatItem[] }) {
  if (made.length === 0 && chats.length === 0) return null
  return (
    <section className="space-y-3" aria-label="Made in Chat">
      {made.length > 0 && (
        <div>
          <h3 className="text-label uppercase tracking-wide text-muted-foreground">Made for this application</h3>
          <ul className="mt-1 space-y-1">
            {made.map((m) => (
              <li key={m.id} className="text-body text-foreground">
                <span className="text-muted-foreground">{typeWord(m.type)}: </span>
                {m.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {chats.length > 0 && (
        <div>
          <h3 className="text-label uppercase tracking-wide text-muted-foreground">Chats about it</h3>
          <ul className="mt-1 space-y-1">
            {chats.map((c) => (
              <li key={c.id}>
                <Link href={`/chat/${encodeURIComponent(c.id)}`} className="text-body text-foreground hover:underline">
                  {c.title || 'Untitled chat'}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function ApplicationMade({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<{ made: MadeItem[]; chats: ChatItem[] } | null>(null)
  useEffect(() => {
    let live = true
    fetch(`/api/chat/made?application=${encodeURIComponent(applicationId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { made?: MadeItem[]; chats?: ChatItem[] } | null) => live && b && setData({ made: b.made ?? [], chats: b.chats ?? [] }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [applicationId])
  return data ? <ApplicationMadeView made={data.made} chats={data.chats} /> : null
}
