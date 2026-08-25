'use client'

// The structured question form: several decisions at once, each single- or
// multi-select, each with room for a note.
//
// WHY A FORM AND NOT PROSE
//   A prose question ("what kind of roles do you want?") puts the user back to
//   typing, and puts the model back to parsing. A typed choice is one tap, is
//   unambiguous downstream, and — the part that matters for an agent that runs
//   unattended — makes it obvious how MANY decisions are outstanding before you
//   commit to any of them.
//
// WHY IT SUBMITS A STRING
//   The answer travels back through the SAME path the existing single-question
//   ask already uses (onAnswer with the user's text). No new resume protocol, no
//   second server contract, and a conversation persisted by either shape still
//   replays. formatAskAnswers owns the wording so the server and the client can
//   never disagree about how a set of answers reads.

import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { formatAskAnswers, type AskAnswer } from '@/lib/harness/ask-user'
import { cn } from '@/lib/utils'

export interface FormQuestion {
  header: string
  question: string
  multiSelect: boolean
  options: Array<{ label: string; detail?: string }>
}

export function QuestionForm({
  questions,
  onSubmit,
  disabled,
}: {
  questions: FormQuestion[]
  onSubmit: (answer: string) => void
  disabled?: boolean
}) {
  // Keyed by header, which the server guarantees is unique per form.
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  function toggle(q: FormQuestion, label: string) {
    setPicked((prev) => {
      const current = prev[q.header] ?? []
      if (!q.multiSelect) {
        // Single-select behaves like a radio: tapping the active option clears
        // it, so a user who picks wrongly is never stuck with a choice.
        return { ...prev, [q.header]: current[0] === label ? [] : [label] }
      }
      return {
        ...prev,
        [q.header]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      }
    })
  }

  const answers: AskAnswer[] = useMemo(
    () =>
      questions.map((q) => ({
        header: q.header,
        selected: picked[q.header] ?? [],
        ...(notes[q.header]?.trim() ? { note: notes[q.header].trim() } : {}),
      })),
    [questions, picked, notes]
  )

  // Answerable as soon as ANY question has an input. Requiring all of them
  // would trap a user who genuinely has no opinion on one — and a partially
  // answered form is still far more useful to the model than nothing, because
  // formatAskAnswers marks the rest "(skipped)" explicitly.
  const canSubmit = answers.some((a) => a.selected.length > 0 || a.note)

  return (
    <div className="space-y-3.5 border-t border-accent/30 px-2.5 py-3">
      {questions.map((q) => {
        const selected = picked[q.header] ?? []
        return (
          <fieldset key={q.header} className="space-y-1.5">
            <legend className="flex items-baseline gap-2">
              <span className="rounded-full bg-sunken px-1.5 py-0.5 font-readout text-[10px] uppercase tracking-wider text-muted-foreground">
                {q.header}
              </span>
              <span className="text-caption font-medium text-foreground">{q.question}</span>
              {q.multiSelect && (
                <span className="text-[10px] text-muted-foreground">choose any</span>
              )}
            </legend>

            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const on = selected.includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={disabled}
                    // Announces both the control's nature and its state: a
                    // multi-select behaves like a checkbox, a single-select
                    // like a radio, and a plain button would announce neither.
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    title={opt.detail}
                    onClick={() => toggle(q, opt.label)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      on
                        ? 'border-accent bg-accent-soft text-accent-deep'
                        : 'border-border bg-card text-foreground hover:bg-sunken'
                    )}
                  >
                    {on && <Check className="h-3 w-3" aria-hidden />}
                    {opt.label}
                  </button>
                )
              })}
            </div>

            {/* Always available, never required. The options are the model's
                guess at the answer space; the note is how a user says something
                it did not think of, without abandoning the form. */}
            <Textarea
              value={notes[q.header] ?? ''}
              onChange={(e) => setNotes((p) => ({ ...p, [q.header]: e.target.value }))}
              disabled={disabled}
              placeholder="Add a note (optional)"
              aria-label={`Note for: ${q.question}`}
              className="min-h-[34px] text-[11px]"
            />
          </fieldset>
        )
      })}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] text-muted-foreground">
          {canSubmit ? 'Unanswered questions are sent as skipped.' : 'Pick an option or add a note.'}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit || disabled}
          onClick={() => onSubmit(formatAskAnswers(answers))}
        >
          Send answers
        </Button>
      </div>
    </div>
  )
}
