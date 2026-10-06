'use client'

// The compose box, fixed at the bottom of the conversation: the text field (grows to 8 lines), a quoted selection when
// there is one, and Send, which becomes Stop while a turn runs. What the person types here is what lands in
// chat_turns.typed; a selection quoted from an answer is kept apart and never counts as their words.

import type { ReactNode } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  running: boolean
  /** A selection quoted from an earlier answer with Ask Cello. */
  quoted?: { text: string } | null
  onRemoveQuote?: () => void
  /** A line above the field, for a state that stops sending ("Chat needs a model."). */
  notice?: string | null
  /** The tiles and chips of this message. */
  above?: ReactNode
  /** The row of controls under the field (Attach, the model picker). */
  controls?: ReactNode
  placeholder?: string
}

const MAX_LINES = 8

export function Composer({ value, onChange, onSend, onStop, running, quoted, onRemoveQuote, notice, above, controls, placeholder = 'Ask Cello to find, compare, write or apply' }: ComposerProps) {
  const canSend = !running && value.trim().length > 0 && !notice
  const lines = Math.min(MAX_LINES, Math.max(1, value.split('\n').length))
  return (
    <div className="rounded-card border border-input bg-card p-2 shadow-card">
      {notice && <p className="mb-2 px-1 text-caption text-muted-foreground">{notice}</p>}
      {above}
      {quoted && (
        <div className="mb-2 flex items-start gap-2 rounded-control border-l-2 border-border bg-muted px-3 py-2 text-caption text-muted-foreground" data-quoted>
          <div className="min-w-0 flex-1">
            <p className="text-label uppercase tracking-wide">Cello's earlier words</p>
            <p className="line-clamp-3 break-words text-foreground">{quoted.text}</p>
          </div>
          <button type="button" aria-label="Remove the quote" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control hover:bg-card" onClick={onRemoveQuote}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
      <textarea
        aria-label="Message"
        rows={lines}
        value={value}
        placeholder={placeholder}
        className="block w-full resize-none bg-transparent px-1 py-1 text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line, and a key that is finishing an IME composition does neither.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSend) onSend()
          }
        }}
      />
      <div className="mt-1 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{controls}</div>
        {running ? (
          <button type="button" aria-label="Stop" className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={onStop}>
            <Square className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={!canSend}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
            onClick={onSend}
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
