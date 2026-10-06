'use client'

// The rail: New chat, Scheduled, Recents, and the person at the bottom. Nothing else (directive 42): no other group.
// A pinned chat is the first in Recents, marked by a pin, never by a heading.

import { useState } from 'react'
import Link from 'next/link'
import { CalendarClock, MoreHorizontal, Pin, Plus, Search, Settings } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface RailChat {
  id: string
  title: string
  pinned: boolean
}

export interface ScheduledRow {
  id: string
  name: string
  /** When it last worked and what it found, from checks.status. */
  detail: string
}

export interface RailProps {
  /** Pinned chats first, then newest first, as chat.list returns them. */
  chats: RailChat[]
  scheduled?: ScheduledRow[]
  activeId?: string | null
  person: { name: string }
  onNew: () => void
  onRename: (id: string, title: string) => void
  onPin: (id: string, pinned: boolean) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
}

const label = (title: string) => title.trim() || 'New chat'

function Row({ chat, active, onRename, onPin, onArchive, onDelete }: { chat: RailChat; active: boolean } & Pick<RailProps, 'onRename' | 'onPin' | 'onArchive' | 'onDelete'>) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(chat.title)
  return (
    <li className={cn('group flex items-center rounded-control', active ? 'bg-muted' : 'hover:bg-muted/60')}>
      {renaming ? (
        <input
          autoFocus
          aria-label="Chat title"
          maxLength={80}
          className="m-1 min-w-0 flex-1 rounded-control border border-input bg-card px-2 py-1 text-body"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setRenaming(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setRenaming(false)
            if (e.key === 'Enter' && draft.trim()) {
              onRename(chat.id, draft)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <Link href={`/chat/${chat.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-body text-foreground" aria-current={active ? 'page' : undefined}>
          {chat.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          <span className="truncate">{label(chat.title)}</span>
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Options for ${label(chat.title)}`}
            className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setDraft(chat.title)
              setRenaming(true)
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPin(chat.id, !chat.pinned)}>{chat.pinned ? 'Unpin' : 'Pin'}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onArchive(chat.id)}>Archive</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              if (window.confirm('Delete this chat? What Cello made in it stays.')) onDelete(chat.id)
            }}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export function Rail({ chats, scheduled = [], activeId, person, onNew, onRename, onPin, onArchive, onDelete }: RailProps) {
  const [query, setQuery] = useState('')
  // ponytail: titles only. Searching what was typed in a chat is chat.recall's words path.
  const shown = query.trim() ? chats.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())) : chats
  return (
    <nav aria-label="Chat" className="flex h-full w-full flex-col gap-4 overflow-y-auto p-3">
      <button type="button" onClick={onNew} className="inline-flex h-9 items-center gap-2 rounded-control border border-input bg-card px-3 text-body font-medium text-foreground hover:bg-muted">
        <Plus className="h-4 w-4" aria-hidden />
        New chat
      </button>

      <section aria-labelledby="rail-scheduled">
        <h2 id="rail-scheduled" className="mb-1 px-2 text-label uppercase tracking-wide text-muted-foreground">
          Scheduled
        </h2>
        {scheduled.length === 0 ? (
          <p className="px-2 text-caption text-muted-foreground">Nothing scheduled.</p>
        ) : (
          <ul className="space-y-1">
            {scheduled.map((s) => (
              <li key={s.id} className="flex items-start gap-2 px-2 py-1 text-caption">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-foreground">{s.name}</span>
                  <span className="block text-muted-foreground">{s.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rail-recents" className="min-h-0 flex-1">
        <h2 id="rail-recents" className="mb-1 px-2 text-label uppercase tracking-wide text-muted-foreground">
          Recents
        </h2>
        <label className="relative mb-1 block">
          <span className="sr-only">Search your chats</span>
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="h-8 w-full rounded-control border border-input bg-card pl-8 pr-2 text-caption text-foreground placeholder:text-muted-foreground"
          />
        </label>
        {chats.length === 0 ? (
          <p className="px-2 text-caption text-muted-foreground">Your chats and what Cello made from them stay here.</p>
        ) : shown.length === 0 ? (
          <p className="px-2 text-caption text-muted-foreground">No chat has that in its title.</p>
        ) : (
          <ul className="space-y-0.5">
            {shown.map((c) => (
              <Row key={c.id} chat={c} active={c.id === activeId} onRename={onRename} onPin={onPin} onArchive={onArchive} onDelete={onDelete} />
            ))}
          </ul>
        )}
      </section>

      <Link href="/settings" className="flex items-center gap-2 rounded-control px-2 py-2 text-body text-foreground hover:bg-muted">
        <Settings className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="truncate">{person.name || 'Settings'}</span>
      </Link>
    </nav>
  )
}
