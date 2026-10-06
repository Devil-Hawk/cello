'use client'

// What this chat holds, in the order it was added, in one row above the turns. Each tile opens its page and has Remove.
// A tile Cello added from a tool result says so. At the cap the row says why [Add] is gone.

import Link from 'next/link'
import { Briefcase, Building2, ClipboardList, FileText, MessageSquare, Paperclip, Plus, User, X } from 'lucide-react'
import { chatHref } from '@/lib/chat/links'
import { MAX_TILES, type AttachKind } from '@/lib/chat/types'
import { cn } from '@/lib/utils'

export interface TileData {
  id: string
  kind: AttachKind
  /** The thing's ref, as `refId` gives it. */
  ref: string
  name: string
  origin: 'person' | 'model'
}

const ICONS: Record<AttachKind, typeof Briefcase> = {
  role: Briefcase,
  preview: Briefcase,
  company: Building2,
  application: ClipboardList,
  person: User,
  chat: MessageSquare,
  made: FileText,
  material: Paperclip,
}

export interface TilesProps {
  tiles: TileData[]
  onRemove: (tile: TileData) => void
  /** Opens a made thing in the side panel. */
  onOpen?: (tile: TileData) => void
  /** Opens the picker. Left out when none is available. */
  onAdd?: () => void
}

export function Tiles({ tiles, onRemove, onOpen, onAdd }: TilesProps) {
  const full = tiles.length >= MAX_TILES
  if (tiles.length === 0 && !onAdd) return null
  return (
    <div className="space-y-1">
      <ul className="flex flex-wrap items-center gap-2" aria-label="Attached to this chat">
        {tiles.map((t) => {
          const Icon = ICONS[t.kind]
          const href = chatHref(t.kind, t.ref)
          const body = (
            <>
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{t.name}</span>
            </>
          )
          const cls = 'flex min-w-0 items-center gap-1.5 text-caption text-foreground hover:underline'
          return (
            <li key={t.id} className="flex max-w-full items-center gap-1 rounded-control border border-border bg-card py-1 pl-2 pr-1 sm:max-w-[16rem]" data-tile={t.kind}>
              {href ? (
                <Link href={href} className={cls}>
                  {body}
                </Link>
              ) : (
                <button type="button" className={cls} onClick={() => onOpen?.(t)}>
                  {body}
                </button>
              )}
              {t.origin === 'model' && <span className="shrink-0 text-label text-muted-foreground">Added by Cello</span>}
              <button
                type="button"
                aria-label={`Remove ${t.name}`}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onRemove(t)}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          )
        })}
        {onAdd && !full && (
          <li>
            <button type="button" className={cn('inline-flex items-center gap-1 rounded-control border border-dashed border-border px-2 py-1 text-caption text-muted-foreground hover:bg-muted hover:text-foreground')} onClick={onAdd}>
              <Plus className="h-4 w-4" aria-hidden />
              Add
            </button>
          </li>
        )}
      </ul>
      {full && <p className="text-caption text-muted-foreground">A chat holds {MAX_TILES}. Remove one to add another.</p>}
    </div>
  )
}
