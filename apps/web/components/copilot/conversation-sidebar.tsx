'use client'

// Left rail: conversation list (GET /api/copilot?list=1), new-chat button,
// per-row delete. Active conversation highlighted.
//
// RESPONSIVE: on desktop this pushes the transcript column exactly like
// before (slim icon rail when collapsed, w-52 list when expanded — state
// still lives here). On mobile (`mobile` prop) the collapsed state renders
// nothing at all — no persistent rail eating width — and the expanded state
// becomes a fixed overlay drawer with a backdrop instead of squeezing the
// transcript, opened from the page's own top-bar toggle so the composer and
// answer always stay reachable at any width.

import { MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatePresence, motion, transitionBase, transitionFast } from '@/components/ui/motion'
import { cn, formatRelativeTime } from '@/lib/utils'
import type { ConversationSummary } from './types'

interface ConversationSidebarProps {
  conversations: ConversationSummary[]
  activeId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  mobile: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

function ConversationList({
  conversations,
  activeId,
  loading,
  onSelect,
  onDelete,
}: Pick<ConversationSidebarProps, 'conversations' | 'activeId' | 'loading' | 'onSelect' | 'onDelete'>) {
  if (loading) {
    return (
      <div className="space-y-1.5 py-1">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }
  if (conversations.length === 0) {
    return <p className="px-2 py-4 text-caption text-muted-foreground">No conversations yet.</p>
  }
  return (
    <>
      {conversations.map((c) => (
        <div
          key={c.id}
          className={cn(
            'group/convo relative flex items-center rounded-control',
            activeId === c.id ? 'bg-accent-soft' : 'hover:bg-muted'
          )}
        >
          <button type="button" onClick={() => onSelect(c.id)} className="min-w-0 flex-1 px-2.5 py-2 text-left">
            <p
              className={cn(
                'truncate text-caption font-medium',
                activeId === c.id ? 'text-accent-deep' : 'text-foreground'
              )}
            >
              {c.title}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{formatRelativeTime(c.updated_at)}</p>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(c.id)
            }}
            className="mr-1 shrink-0 rounded-control p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-card hover:text-rose-500 focus-visible:opacity-100 group-hover/convo:opacity-100"
            aria-label={`Delete "${c.title}"`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </>
  )
}

export function ConversationSidebar({
  conversations,
  activeId,
  loading,
  onSelect,
  onNew,
  onDelete,
  mobile,
  open,
  onOpenChange,
}: ConversationSidebarProps) {
  const listProps = { conversations, activeId, loading, onSelect, onDelete }

  // Mobile: no persistent rail — collapsed means genuinely gone, so the
  // transcript gets the full width. Reachable via the page's top-bar toggle.
  if (mobile) {
    return (
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transitionFast}
              className="fixed inset-0 z-40 bg-foreground/40"
              onClick={() => onOpenChange(false)}
              aria-hidden="true"
            />
            <motion.div
              key="panel"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={transitionBase}
              role="dialog"
              aria-label="Conversations"
              className="fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-xs flex-col border-r bg-card p-3 shadow-pop"
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-caption font-semibold text-foreground">Conversations</h2>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close conversations"
                  className="rounded-control p-1.5 hover:bg-muted"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onNew()
                  onOpenChange(false)
                }}
                className="mb-3 justify-start gap-2"
              >
                <MessageSquarePlus className="h-4 w-4" />
                New chat
              </Button>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto scrollbar-thin">
                <ConversationList {...listProps} onSelect={(id) => {
                  onSelect(id)
                  onOpenChange(false)
                }} />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    )
  }

  if (!open) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r pr-2">
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-label="Show conversations"
          className="rounded-control p-1.5 hover:bg-card"
        >
          <PanelLeftOpen className="h-[18px] w-[18px] text-muted-foreground" />
        </button>
        <button type="button" onClick={onNew} aria-label="New chat" className="rounded-control p-1.5 hover:bg-card">
          <MessageSquarePlus className="h-[18px] w-[18px] text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex w-52 shrink-0 flex-col border-r pr-3">
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Hide conversations"
          className="rounded-control p-1 hover:bg-card"
        >
          <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
      <Button variant="outline" size="sm" onClick={onNew} className="mb-3 justify-start gap-2">
        <MessageSquarePlus className="h-4 w-4" />
        New chat
      </Button>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto scrollbar-thin">
        <ConversationList {...listProps} />
      </div>
    </div>
  )
}
