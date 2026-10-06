'use client'

// The one picker behind [Add] and "@": the person's own roles, companies, applications, people, earlier chats and made things whose
// name holds the words typed. It lists names only; what a pick does (a tile at once, or a chip until Send) is the
// caller's. A search that cannot be read says so and never reads as "no match".

import { useEffect, useState } from 'react'
import type { Found } from '@/lib/chat/find'

const KIND_WORDS: Record<Found['kind'], string> = { role: 'Role', company: 'Company', application: 'Application', person: 'Person', chat: 'Earlier chat', made: 'Made' }
const DEBOUNCE_MS = 200

export function Finder({ query, onPick }: { query: string; onPick: (found: Found) => void }) {
  const [found, setFound] = useState<Found[] | null>(null)
  const [failed, setFailed] = useState(false)
  const words = query.trim()

  useEffect(() => {
    setFailed(false)
    if (!words) return setFound(null)
    let live = true
    const timer = setTimeout(() => {
      fetch(`/api/chat/find?q=${encodeURIComponent(words)}`, { cache: 'no-store' })
        .then((res) => (res.ok ? (res.json() as Promise<{ found: Found[] }>) : Promise.reject(new Error('read'))))
        .then((body) => live && setFound(body.found))
        .catch(() => live && setFailed(true))
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [words])

  if (!words) return <p className="px-2 py-1.5 text-caption text-muted-foreground">Type a name to find a role, company, application, person, earlier chat or made thing.</p>
  if (failed) return <p className="px-2 py-1.5 text-caption text-muted-foreground">Cello could not search just now. Try again.</p>
  if (!found) return <p className="px-2 py-1.5 text-caption text-muted-foreground">Searching</p>
  if (found.length === 0) return <p className="px-2 py-1.5 text-caption text-muted-foreground">Nothing of yours has that in its name.</p>
  return (
    <ul className="max-h-60 overflow-y-auto" aria-label="Matches">
      {found.map((f) => (
        <li key={`${f.kind}:${f.id}`}>
          <button type="button" className="flex w-full min-w-0 items-baseline gap-2 rounded-control px-2 py-1.5 text-left text-body text-foreground hover:bg-muted" onClick={() => onPick(f)}>
            <span className="min-w-0 truncate">{f.name}</span>
            {f.detail && <span className="min-w-0 truncate text-caption text-muted-foreground">{f.detail}</span>}
            <span className="ml-auto shrink-0 text-label text-muted-foreground">{KIND_WORDS[f.kind]}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
