'use client'

// Live-updating tool-call step card. A single card represents one `step` in
// an assistant turn and is upserted in place as SSE events land for that step
// (thought -> tool_call -> observation), so it visibly progresses from
// "thinking…" to a named tool call to a completed/failed result without ever
// remounting. The `paused` status (thinking-mode 'review', or the
// unconditional submit/send confirmation guard) renders an editable directive
// box with Approve/Continue — or, when `requiresConfirmation` is set, a
// Confirm/Decline pair that never treats silence as a yes. The `ask` status
// (the model stopped to ask the user something) renders the question with
// clickable option chips plus a free-text reply.
//
// HARNESS FEEL: the SSE wire delivers each step's reasoning/thought as one
// complete string per event (see the route's wire contract) — `live` (true
// only for steps in a turn actually running/resuming this session, never for
// steps reconstructed from persisted history) opts a card into typing that
// text in via useRevealedText instead of popping it in whole, and into a
// mount/settle motion pass, so the machinery reads as working, not static.
// StepList additionally collapses the WHOLE step cluster into one compact
// summary once its turn has settled — machinery stays legible but
// subordinate to the answer (see the "harness, not dashboard" requirement).

import { QuestionForm, type FormQuestion } from './question-form'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, Cog, HelpCircle, Loader2, Pause, Search, SquareStack, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AnimatePresence, motion, transitionFast } from '@/components/ui/motion'
import { cn } from '@/lib/utils'
import { isReadTool, isRunTool } from '@/lib/harness/copilot-tool-catalog'
import { useRevealedText } from './hooks'
import { ObservationView } from './observation-view'
import type { StepEntry, StepStatus } from './types'

/** One-line collapsed summary for the card header. The expanded body is
 *  rendered structurally by <ObservationView>. */
function formatObservation(obs: unknown): { summary: string; pretty: string } {
  if (obs == null || obs === '') return { summary: '', pretty: '' }
  let value: unknown = obs
  if (typeof obs === 'string') {
    try {
      value = JSON.parse(obs)
    } catch {
      const summary = obs.length > 100 ? `${obs.slice(0, 100)}…` : obs
      return { summary, pretty: obs }
    }
  }
  if (typeof value !== 'object' || value === null) {
    const s = String(value)
    return { summary: s, pretty: s }
  }
  const o = value as Record<string, unknown>
  const pretty = JSON.stringify(value, null, 2)
  if (typeof o.error === 'string') return { summary: o.error, pretty }
  if (typeof o.note === 'string' && Object.keys(o).length <= 2) return { summary: o.note, pretty }
  if (typeof o.found === 'number' && typeof o.inserted === 'number') {
    return { summary: `${o.found} found, ${o.inserted} new`, pretty }
  }
  if (typeof o.scored === 'number' && typeof o.candidatesConsidered === 'number') {
    return {
      summary: `scored ${o.scored}/${o.candidatesConsidered}${(o.failed as number) > 0 ? `, ${o.failed} failed` : ''}`,
      pretty,
    }
  }
  if (Array.isArray(o.jobs)) return { summary: `${(o.count as number) ?? o.jobs.length} job(s)`, pretty }
  if (Array.isArray(o.runs)) return { summary: `${o.runs.length} run(s)`, pretty }
  if (Array.isArray(o.contacts)) return { summary: `${(o.count as number) ?? o.contacts.length} contact(s)`, pretty }
  if (typeof o.atsScore === 'number') return { summary: `ATS ${o.atsScore} -> ${o.rescore ?? o.atsScore}`, pretty }
  if (typeof o.status === 'string' && typeof o.runId === 'string') return { summary: `run ${String(o.status)}`, pretty }
  if (typeof o.kitId === 'string') return { summary: `kit ready (${(o.questionCount as number) ?? 0} questions)`, pretty }
  if (typeof o.dossierId === 'string' || typeof o.exists === 'boolean') return { summary: 'company research', pretty }
  const keys = Object.keys(o)
  return { summary: keys.length ? keys.slice(0, 4).join(', ') : 'done', pretty }
}

function isErrorObservation(obs: unknown): boolean {
  if (obs == null) return false
  let value: unknown = obs
  if (typeof obs === 'string') {
    try {
      value = JSON.parse(obs)
    } catch {
      return false
    }
  }
  return typeof value === 'object' && value !== null && 'error' in (value as Record<string, unknown>)
}

function StepGlyph({ tool, status }: { tool?: string; status: StepStatus }) {
  if (status === 'error') return <X className="h-3.5 w-3.5 text-destructive" />
  if (status === 'skipped') return <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
  // paused/ask/thinking/running are the only genuinely live states here — the
  // step is either actually in flight or actively waiting on the user, so
  // these alone keep the live accent. Every branch below this point describes
  // a SETTLED step (the tool already ran and this is just its icon), which
  // gets the neutral muted tone instead — see the file header for why.
  if (status === 'paused') return <Pause className="h-3.5 w-3.5 text-accent-deep" />
  if (status === 'ask') return <HelpCircle className="h-3.5 w-3.5 text-accent-deep" />
  if (status === 'thinking' || status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-deep" />
  }
  if (tool === 'ask_user') return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
  if (tool === 'source_jobs') return <Search className="h-3.5 w-3.5 text-muted-foreground" />
  if (tool && isRunTool(tool)) return <SquareStack className="h-3.5 w-3.5 text-muted-foreground" />
  if (tool && isReadTool(tool)) return <Search className="h-3.5 w-3.5 text-muted-foreground" />
  return <Cog className="h-3.5 w-3.5 text-muted-foreground" />
}

/** Blinking end-of-text caret for the block currently being typed in. A
 *  no-op flat mark under prefers-reduced-motion (the global CSS rule in
 *  globals.css collapses the animation to instant, so it just renders
 *  static — still a visible signal, never blinking). */
function LiveCaret({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] animate-pulse bg-accent', className)}
    />
  )
}

interface StepCardProps {
  step: StepEntry
  /** True only for steps belonging to a turn actually streaming/resuming
   *  this session — opts the card into typed-reveal + mount motion. Steps
   *  reconstructed from persisted history render fully formed, instantly. */
  live?: boolean
  onApprove?: () => void
  onContinue?: (directive: string) => void
  /** Guarded (requiresConfirmation) pause only: explicit go-ahead. */
  onConfirm?: () => void
  /** Guarded (requiresConfirmation) pause only: explicit no, no note. */
  onDecline?: (note?: string) => void
  /** Ask only: answer the question (free text, or an option's label). */
  onAnswer?: (answer: string) => void
}

export function StepCard({ step, live, onApprove, onContinue, onConfirm, onDecline, onAnswer }: StepCardProps) {
  // Expanded while the step is live so reasoning and results are visible as
  // they stream, rather than hidden behind a click the user never makes.
  // Open while the step is live so reasoning and results stream into view,
  // then collapse once it settles so a long transcript stays scannable. A
  // manual toggle sticks: once the user decides, stop auto-managing this card.
  const isLive = step.status === 'thinking' || step.status === 'running'
  const [userToggled, setUserToggled] = useState(false)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!userToggled) setOpen(isLive)
  }, [isLive, userToggled])
  const [directive, setDirective] = useState(step.thought ?? '')
  // Separate from `directive` on purpose — see the guarded block below.
  const [declineNote, setDeclineNote] = useState('')
  const [answer, setAnswer] = useState('')
  const isPaused = step.status === 'paused'
  const isGuarded = isPaused && Boolean(step.requiresConfirmation)
  const isAsk = step.status === 'ask' || step.tool === 'ask_user'
  const isPendingAsk = step.status === 'ask'
  const isError = step.status === 'error' || isErrorObservation(step.observation)
  const argStr = step.args && Object.keys(step.args).length ? JSON.stringify(step.args) : ''
  const { summary } = formatObservation(step.observation)
  const resolvedAnswer =
    step.answer ??
    (step.observation && typeof step.observation === 'object' && step.observation !== null
      ? (step.observation as { answer?: unknown }).answer
      : undefined)

  const thoughtReveal = useRevealedText(step.thought ?? '', Boolean(live))
  const reasoningReveal = useRevealedText(step.reasoning ?? '', Boolean(live))
  const thoughtTyping = live && isLive && thoughtReveal.revealing
  const reasoningTyping = live && isLive && reasoningReveal.revealing

  // Imperative, ONE-WAY open: while reasoning is actively typing in, force
  // the <details> open so the user watches it stream. Deliberately NOT a
  // React `open={reasoningTyping}` prop — that would force it back CLOSED
  // the instant the reveal finishes (React removes the attribute on that
  // re-render), fighting anyone who wanted to keep reading it. Setting the
  // DOM property directly, once, leaves it fully native/uncontrolled
  // afterward — the user's own click on <summary> just works.
  const reasoningDetailsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (reasoningTyping && reasoningDetailsRef.current) reasoningDetailsRef.current.open = true
  }, [reasoningTyping])

  return (
    <motion.div
      layout="position"
      initial={live ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={transitionFast}
      className={cn(
        'rounded-control border bg-sunken/60',
        isGuarded
          ? 'border-destructive/40 bg-destructive/5'
          : isPaused || isPendingAsk
          ? 'border-accent/50 bg-accent-soft/30'
          : 'border-border'
      )}
    >
      <button
        type="button"
        onClick={() => {
          setUserToggled(true)
          setOpen((v) => !v)
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <StepGlyph tool={step.tool} status={isError ? 'error' : step.status} />
        </span>
        {isAsk ? (
          <span className="truncate text-label font-medium text-foreground">{step.question ?? 'Question'}</span>
        ) : step.tool ? (
          <code className="text-label font-medium text-foreground">{step.tool}</code>
        ) : (
          // A reasoning-only step (the model deliberated and went straight to
          // a final answer, no tool call in between — see settleLingeringSteps
          // in page.tsx) still has no tool name once it settles; "thinking…"
          // would misdescribe it as still in progress once status is 'done'.
          <span className="text-label font-medium text-muted-foreground">
            {isLive ? 'thinking…' : 'reasoning'}
          </span>
        )}
        {!isAsk && argStr && <span className="truncate text-[11px] text-muted-foreground/80">{argStr}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {isGuarded ? (
            <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-destructive">
              <AlertTriangle className="h-3 w-3" /> confirm to proceed
            </span>
          ) : isPaused ? (
            <span className="text-[11px] font-medium uppercase tracking-wide text-accent-deep">
              paused for review
            </span>
          ) : isPendingAsk ? (
            <span className="text-[11px] font-medium uppercase tracking-wide text-accent-deep">waiting on you</span>
          ) : step.status === 'running' ? (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">running…</span>
          ) : (
            <span className="hidden max-w-[16rem] truncate text-[11px] text-muted-foreground sm:inline">
              {summary}
            </span>
          )}
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {step.thought && !isPaused && !isAsk && (
        <div className="border-t border-border/60 px-2.5 py-1.5">
          <p className="text-body leading-relaxed text-foreground">
            {live ? thoughtReveal.text : step.thought}
            {thoughtTyping && <LiveCaret />}
          </p>
        </div>
      )}
      {open && step.reasoning && !isPaused && (
        <details ref={reasoningDetailsRef} className="group/reason border-t border-border/60 bg-muted/30">
          <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted/50">
            Reasoning
          </summary>
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap px-2.5 pb-2 text-caption leading-relaxed text-muted-foreground scrollbar-thin">
            {live ? reasoningReveal.text : step.reasoning}
            {reasoningTyping && <LiveCaret />}
          </p>
        </details>
      )}
      {isGuarded && step.reason && (
        <div className="border-t border-destructive/20 px-2.5 py-1.5">
          <p className="text-[12px] leading-relaxed text-destructive">{step.reason}</p>
        </div>
      )}
      {open && !isAsk && step.observation != null && step.observation !== '' && (
        <motion.div
          initial={live ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={transitionFast}
          className="border-t border-border px-2.5 py-2"
        >
          <ObservationView observation={step.observation} />
        </motion.div>
      )}
      {isAsk && typeof resolvedAnswer === 'string' && (
        <div className="border-t border-border px-2.5 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Answer</p>
          <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">{resolvedAnswer}</p>
        </div>
      )}
      {isPendingAsk && step.questions && step.questions.length > 0 && (
        <QuestionForm
          questions={step.questions}
          onSubmit={(answer) => onAnswer?.(answer)}
        />
      )}
      {isPendingAsk && !(step.questions && step.questions.length > 0) && (
        <div className="space-y-2 border-t border-accent/30 px-2.5 py-2.5">
          {step.options && step.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {step.options.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  title={opt.detail}
                  onClick={() => onAnswer?.(opt.label)}
                  className="rounded-full border border-accent/40 bg-card px-2.5 py-1 text-[11px] font-medium text-accent-deep transition-colors hover:bg-accent-soft"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Or answer in your own words…"
              className="min-h-[44px] text-caption"
            />
            <Button
              type="button"
              size="sm"
              disabled={!answer.trim()}
              onClick={() => {
                onAnswer?.(answer.trim())
                setAnswer('')
              }}
            >
              Answer
            </Button>
          </div>
        </div>
      )}
      {isGuarded && (
        <div className="space-y-2 border-t border-destructive/20 px-2.5 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            This is irreversible — it never runs without your explicit confirmation, bypass mode or not
          </p>
          <Textarea
            value={declineNote}
            onChange={(e) => setDeclineNote(e.target.value)}
            placeholder="Optional note if you're saying no — e.g. what to do instead"
            aria-label="Note explaining your decision"
            className="min-h-[52px] text-caption"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              // Declines UNCONDITIONALLY. This previously branched on the
              // note being non-empty, and the box was prefilled with the
              // model's own reasoning — so the button that means "do not send
              // this to a real person" took the continue path and handed that
              // reasoning back as the user's instruction.
              onClick={() => onDecline?.(declineNote.trim() || undefined)}
            >
              Decline
            </Button>
            <Button
              type="button"
              size="sm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onConfirm?.()}
            >
              Confirm
            </Button>
          </div>
        </div>
      )}
      {isPaused && !isGuarded && (
        <div className="space-y-2 border-t border-accent/30 px-2.5 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Review mode — edit the plan or approve it as-is
          </p>
          <Textarea
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            className="min-h-[64px] text-caption"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => onApprove?.()}>
              Approve
            </Button>
            <Button type="button" size="sm" onClick={() => onContinue?.(directive)}>
              Continue
            </Button>
          </div>
        </div>
      )}
    </motion.div>
  )
}

export function StepList({
  steps,
  live,
  /** True once the parent turn has finished producing (no longer pending,
   *  and nothing left needs the user's input) — collapses the whole cluster
   *  into one compact summary so the answer stays the thing in focus.
   *  Ignored (cluster always expanded) while false. */
  settled,
  onApprove,
  onContinue,
  onConfirm,
  onDecline,
  onAnswer,
}: { steps: StepEntry[]; live?: boolean; settled?: boolean } & Omit<StepCardProps, 'step' | 'live'>) {
  // Collapse-once-settled, sticky once the user has picked either way — same
  // pattern as an individual card's own open state, one level up.
  const [userToggled, setUserToggled] = useState(false)
  const [groupOpen, setGroupOpen] = useState(!settled)
  useEffect(() => {
    if (!userToggled) setGroupOpen(!settled)
  }, [settled, userToggled])

  if (!steps.length) return null
  const done = steps.filter((s) => s.status === 'done').length
  const toolNames = Array.from(
    new Set(steps.filter((s) => s.tool && s.tool !== 'ask_user').map((s) => s.tool as string))
  )
  const showList = groupOpen || !settled

  return (
    <div className="mb-3 space-y-1.5">
      <button
        type="button"
        onClick={() => {
          setUserToggled(true)
          setGroupOpen((v) => !v)
        }}
        disabled={!settled}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors',
          settled && 'hover:bg-muted/60'
        )}
      >
        <Cog className={cn('h-3 w-3', !settled && 'animate-spin')} />
        <span>
          {steps.length} step{steps.length === 1 ? '' : 's'} · {done} completed
        </span>
        {toolNames.length > 0 && (
          <span className="hidden min-w-0 truncate normal-case tracking-normal text-muted-foreground/70 sm:inline">
            — {toolNames.join(', ')}
          </span>
        )}
        {settled && (
          <ChevronRight className={cn('ml-auto h-3 w-3 shrink-0 transition-transform', showList && 'rotate-90')} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {showList && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transitionFast}
            className="space-y-1.5 overflow-hidden"
          >
            {steps.map((s) => (
              <StepCard
                key={s.step}
                step={s}
                live={live}
                onApprove={onApprove}
                onContinue={onContinue}
                onConfirm={onConfirm}
                onDecline={onDecline}
                onAnswer={onAnswer}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
