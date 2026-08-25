'use client'

// The resume editor: a Markdown source textarea with a formatting toolbar and
// the keyboard shortcuts anyone editing a resume expects (Ctrl/Cmd + B, I, K).
//
// WHY A TEXTAREA AND NOT A CONTENTEDITABLE RICH-TEXT SURFACE
//   The saved artefact is Markdown (content_json.markdown), and the plain text
//   an ATS receives is DERIVED from it on the server. A contenteditable would
//   put a second, lossy model in the middle — one that has to be serialised
//   back to Markdown on every keystroke and that silently accepts pasted HTML.
//   Editing the source and rendering it live next door keeps exactly one
//   representation of the document, which is the whole point of the contract in
//   lib/resume/types.ts. The user never has to *read* Markdown to work here:
//   the preview pane is the readable copy.
//
// SELECTION SURVIVES A CONTROLLED VALUE
//   The textarea is controlled by the parent, so applying a command means
//   handing the parent a new string and then putting the caret back where the
//   command said it should go. `pendingSelection` carries that across the
//   re-render; the effect below runs after every commit and restores it. Without
//   this the caret jumps to the end of the document on every toolbar press.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  activeMarks,
  insertLink,
  toggleBulletList,
  toggleHeading,
  toggleInline,
  toggleOrderedList,
  type TextEdit,
  type TextSelection,
} from './markdown-commands'
import { MarkdownToolbar, type ToolbarCommand } from './markdown-toolbar'

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** Accessible name for the editing surface itself. */
  label?: string
  /** Id of the element describing the editor (a hint line under the toolbar). */
  describedById?: string
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  label = 'Resume Markdown editor',
  describedById,
}: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const pendingSelection = useRef<TextSelection | null>(null)
  const [selection, setSelection] = useState<TextSelection>({ start: 0, end: 0 })

  // Runs after every commit: if a command asked for a selection, restore it.
  useEffect(() => {
    const el = ref.current
    const pending = pendingSelection.current
    if (!el || !pending) return
    pendingSelection.current = null
    el.focus()
    el.setSelectionRange(pending.start, pending.end)
    setSelection(pending)
  })

  const syncSelection = useCallback(() => {
    const el = ref.current
    if (!el) return
    setSelection({ start: el.selectionStart, end: el.selectionEnd })
  }, [])

  const apply = useCallback(
    (edit: TextEdit) => {
      pendingSelection.current = edit.selection
      onChange(edit.value)
    },
    [onChange]
  )

  const run = useCallback(
    (command: ToolbarCommand) => {
      const el = ref.current
      // Prefer the live DOM selection: it is authoritative even if a state
      // update has not landed yet (e.g. click straight after typing).
      const sel: TextSelection = el ? { start: el.selectionStart, end: el.selectionEnd } : selection
      switch (command) {
        case 'bold':
          return apply(toggleInline(value, sel, 'bold'))
        case 'italic':
          return apply(toggleInline(value, sel, 'italic'))
        case 'h1':
          return apply(toggleHeading(value, sel, 1))
        case 'h2':
          return apply(toggleHeading(value, sel, 2))
        case 'h3':
          return apply(toggleHeading(value, sel, 3))
        case 'bullet':
          return apply(toggleBulletList(value, sel))
        case 'ordered':
          return apply(toggleOrderedList(value, sel))
        case 'link':
          return apply(insertLink(value, sel))
      }
    },
    [apply, selection, value]
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // metaKey on macOS, ctrlKey elsewhere. altKey excluded so Alt+Ctrl
      // combinations a keyboard layout uses for real characters still type.
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const command: ToolbarCommand | null =
        key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'k' ? 'link' : null
      if (!command) return
      event.preventDefault()
      run(command)
    },
    [run]
  )

  const marks = useMemo(() => activeMarks(value, selection), [value, selection])
  const words = useMemo(() => (value.trim() ? value.trim().split(/\s+/).length : 0), [value])

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <MarkdownToolbar marks={marks} onCommand={run} />
      <Textarea
        ref={ref}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd })
        }}
        onSelect={syncSelection}
        onKeyUp={syncSelection}
        onClick={syncSelection}
        onFocus={syncSelection}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedById}
        spellCheck
        className="min-h-0 flex-1 resize-none font-sans text-caption leading-relaxed"
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Formatting is Markdown — the toolbar writes it for you.</span>
        <span className="tabular-nums">{words.toLocaleString()} words</span>
      </div>
    </div>
  )
}
