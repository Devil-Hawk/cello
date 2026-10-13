'use client'

// The mode control under the compose box, beside the model picker and separate from it: "Ask first" or "Hands-off",
// for this chat from the next turn (null follows Settings). The same details shape as the model picker. When Hands-off
// cannot run (Send for me off, paused, a demo) the choice is greyed with the reason, in code's words (lib/chat/mode.ts).

import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { closesLadder } from '@/components/chat/model-picker'
import { HANDS_OFF_WORD, MODE_LABELS, type Mode, type ResolvedMode } from '@/lib/chat/mode'
import { cn } from '@/lib/utils'

export interface ModePickerProps {
  /** This chat's own mode; null follows Settings. */
  chat: Mode | null
  settings: Mode
  /** What the next turn without a keyword runs under. */
  resolved: ResolvedMode
  /** Null follows Settings again. */
  onPick: (mode: Mode | null) => void
}

const BLOCKED: Record<NonNullable<ResolvedMode['blocked']>, string> = {
  send_for_me_off: 'Needs Send for me on, under Settings.',
  paused: 'Cello is paused.',
  demo: 'Not in a demo.',
}

const HELP: Record<Mode, string> = {
  ask: 'Find, research, draft and tailor run alone. Applying waits for you.',
  hands_off: `Applications you ask for go to Send for me without a stop. Typing ${HANDS_OFF_WORD} does this for one message.`,
}

/** The summary's words: the mode that runs, and that it was blocked when it was. */
export const modeSummary = (r: ResolvedMode): string => (r.blocked ? `${MODE_LABELS.ask} (Hands-off blocked)` : MODE_LABELS[r.mode])

export function ModePicker({ chat, settings, resolved, onPick }: ModePickerProps) {
  const box = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => closesLadder({ target: e.target }, box.current) && box.current?.removeAttribute('open')
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const current = chat ?? settings
  const pick = (m: Mode | null) => {
    onPick(m)
    box.current?.removeAttribute('open')
  }
  return (
    <details
      ref={box}
      className="relative"
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onKeyDown={(e) => {
        if (!closesLadder({ key: e.key }, box.current) || !box.current) return
        e.stopPropagation()
        box.current.open = false
        box.current.querySelector('summary')?.focus()
      }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-control px-2 py-1 text-caption text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Mode: ${modeSummary(resolved)}`}>
        <span className="truncate">{modeSummary(resolved)}</span>
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
      </summary>
      <div className="absolute bottom-full left-0 z-30 mb-1 w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-card border border-border bg-card p-3 shadow-pop" role="group" aria-label="Mode">
        <ul className="space-y-1">
          {(['ask', 'hands_off'] as const).map((m) => {
            const why = m === 'hands_off' && resolved.blocked ? BLOCKED[resolved.blocked] : ''
            return (
              <li key={m}>
                <button
                  type="button"
                  disabled={Boolean(why)}
                  aria-pressed={current === m}
                  className={cn('flex min-h-11 w-full flex-col items-start justify-center rounded-control px-2 py-1.5 text-left text-caption hover:bg-muted disabled:pointer-events-none disabled:opacity-50', current === m && 'bg-muted')}
                  onClick={() => pick(m)}
                >
                  <span className="text-foreground">{MODE_LABELS[m]}</span>
                  <span className="text-muted-foreground">{why || HELP[m]}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="text-caption text-muted-foreground">{chat ? `Set for this chat. Settings says ${MODE_LABELS[settings]}.` : `From Settings. A choice here is for this chat only.`}</p>
        {chat && (
          <button type="button" className="min-h-11 rounded-control border border-border px-2 py-1 text-caption text-foreground hover:bg-muted" onClick={() => pick(null)}>
            Use the Settings choice
          </button>
        )}
      </div>
    </details>
  )
}
