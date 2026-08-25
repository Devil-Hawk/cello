'use client'

// The formatting toolbar over the resume editor.
//
// Presentational only: it renders buttons and reports which one was pressed.
// Every transform lives in markdown-commands.ts, and `marks` — the pressed
// state — comes from that same module's predicates, so a button announced as
// pressed is exactly a button that will REMOVE formatting when clicked.
//
// ACCESSIBILITY NOTES (these are requirements, not decoration)
//   - The buttons are icon-only, so each carries an aria-label that names the
//     action AND its shortcut; the icon itself is aria-hidden so a screen
//     reader never reads a decorative glyph.
//   - Each is a real toggle: aria-pressed reflects state rather than a colour
//     change that only a sighted user can perceive.
//   - role="group" (not role="toolbar"): a toolbar promises arrow-key roving
//     focus, and promising it without implementing it is worse for keyboard
//     users than plain tab stops, which is what these are.

import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ActiveMarks } from './markdown-commands'

/** Everything the toolbar can ask the editor to do. */
export type ToolbarCommand = 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'link'

export interface MarkdownToolbarProps {
  marks: ActiveMarks
  onCommand: (command: ToolbarCommand) => void
  disabled?: boolean
  className?: string
}

interface ButtonSpec {
  command: ToolbarCommand
  label: string
  icon: typeof Bold
  pressed: (marks: ActiveMarks) => boolean
  /** Start a new visual group (a thin separator) before this button. */
  startsGroup?: boolean
}

const BUTTONS: ButtonSpec[] = [
  { command: 'bold', label: 'Bold (Ctrl+B)', icon: Bold, pressed: (m) => m.bold },
  { command: 'italic', label: 'Italic (Ctrl+I)', icon: Italic, pressed: (m) => m.italic },
  {
    command: 'h1',
    label: 'Heading 1 — your name',
    icon: Heading1,
    pressed: (m) => m.heading === 1,
    startsGroup: true,
  },
  {
    command: 'h2',
    label: 'Heading 2 — section title',
    icon: Heading2,
    pressed: (m) => m.heading === 2,
  },
  {
    command: 'h3',
    label: 'Heading 3 — role or company',
    icon: Heading3,
    pressed: (m) => m.heading === 3,
  },
  {
    command: 'bullet',
    label: 'Bulleted list',
    icon: List,
    pressed: (m) => m.bulletList,
    startsGroup: true,
  },
  { command: 'ordered', label: 'Numbered list', icon: ListOrdered, pressed: (m) => m.orderedList },
  {
    command: 'link',
    label: 'Insert link (Ctrl+K)',
    icon: Link2,
    pressed: () => false,
    startsGroup: true,
  },
]

export function MarkdownToolbar({ marks, onCommand, disabled, className }: MarkdownToolbarProps) {
  return (
    <div
      role="group"
      aria-label="Resume formatting"
      className={cn(
        'flex flex-wrap items-center gap-0.5 rounded-control border bg-sunken/60 p-1',
        className
      )}
    >
      {BUTTONS.map(({ command, label, icon: Icon, pressed, startsGroup }) => {
        const isPressed = pressed(marks)
        return (
          <div key={command} className="flex items-center">
            {startsGroup && <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />}
            <button
              type="button"
              // onMouseDown + preventDefault keeps the textarea's selection: a
              // plain click would blur it first and the command would then have
              // nothing to format.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCommand(command)}
              disabled={disabled}
              aria-label={label}
              aria-pressed={isPressed}
              title={label}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:pointer-events-none disabled:opacity-40',
                isPressed
                  ? 'bg-card text-foreground shadow-card'
                  : 'text-muted-foreground hover:bg-card/70 hover:text-foreground'
              )}
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
