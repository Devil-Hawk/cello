'use client'

// Right rail: run list + run detail, extracted from the old standalone /agent
// page (now a redirect into /copilot — see app/(app)/agent/page.tsx). Same
// data source and polling behavior as before (GET /api/harness/run, poll
// every 2s only while the selected run is queued/planning/running); folded
// into one scrollable column instead of a two-column grid since this now
// lives in a narrow collapsible rail instead of its own page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  PauseCircle,
  Send,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { AnimatePresence, motion, transitionBase, transitionFast } from '@/components/ui/motion'
import { cn, formatRelativeTime } from '@/lib/utils'

// 'completed_with_errors' = at least one step failed (or the run was aborted
// on budget/deadline before finishing) but something still completed — kept
// distinct from plain 'completed' so this panel never shows a run with a
// failed step as a plain success. 'incomplete' = the run PAUSED at its own
// wall-clock deadline with steps still pending — NOT a failure; the cron
// route auto-resumes it (bounded), which is why it gets its own tone/icon/
// copy below instead of reusing 'completed_with_errors'. See
// lib/harness/executor.ts and the RunStatus doc in lib/harness/types.ts.
type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

interface AgentRun {
  id: string
  goal: string
  status: RunStatus
  budget_tokens: number
  spent_tokens: number
  error: string | null
  created_at: string
  finished_at: string | null
}

interface PlanStepMeta {
  label: string
  agent_type: string
  dependsOn?: string[]
}

interface AgentStep {
  id: string
  agent_type: string
  label: string
  status: StepStatus
  tokens_used: number | null
  output: unknown
  created_at: string
}

const ACTIVE_STATUSES: RunStatus[] = ['queued', 'planning', 'running']

/**
 * Everything needed to render a run's status as a badge: label (never a raw
 * enum value — 'completed_with_errors' reads as a sentence, not a token),
 * tone, and icon. 'incomplete' deliberately does NOT reuse 'running'/
 * 'planning''s accent tone — that color is this app's single "live right
 * now" signal (see tailwind.config.ts), and a paused run is exactly NOT
 * live right now — nor 'completed_with_errors''s warn tone, since paused
 * means "will finish on its own", a materially better outcome than "finished
 * with something broken". 'muted' + a pause icon reads as "waiting", not
 * "wrong".
 */
const STATUS_META: Record<RunStatus, { label: string; tone: BadgeTone; icon: LucideIcon; spin?: boolean }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: CircleDashed },
  planning: { label: 'Planning', tone: 'accent', icon: Loader2, spin: true },
  running: { label: 'Running', tone: 'accent', icon: Loader2, spin: true },
  completed: { label: 'Completed', tone: 'good', icon: CheckCircle2 },
  completed_with_errors: { label: 'Completed with errors', tone: 'warn', icon: AlertTriangle },
  incomplete: { label: 'Paused — resuming', tone: 'muted', icon: PauseCircle },
  failed: { label: 'Failed', tone: 'bad', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: Ban },
}

function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <Badge tone={meta.tone} className={className}>
      <Icon className={cn('h-3 w-3', meta.spin && 'animate-spin')} />
      {meta.label}
    </Badge>
  )
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-deep" />
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
    case 'skipped':
      return <Ban className="h-3.5 w-3.5 text-muted-foreground" />
    default:
      return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
  }
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface RunsPanelProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Mobile: collapsed renders nothing (no persistent rail); expanded
   *  renders as a fixed overlay from the right instead of pushing the
   *  transcript column — same reasoning as ConversationSidebar's `mobile`. */
  mobile?: boolean
}

export function RunsPanel({ collapsed, onToggleCollapsed, mobile }: RunsPanelProps) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [steps, setSteps] = useState<AgentStep[]>([])
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null)
  const [goal, setGoal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/harness/run?limit=30')
      const data = await res.json()
      if (Array.isArray(data.runs)) {
        setRuns(data.runs as AgentRun[])
        setSelectedId((prev) => prev ?? (data.runs[0]?.id ?? null))
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/harness/run?runId=${runId}`)
      const data = await res.json()
      if (data.run) setSelectedRun(data.run as AgentRun)
      if (Array.isArray(data.steps)) setSteps(data.steps as AgentStep[])
    } catch {
      /* ignore */
    }
  }, [])

  // Lazy-load the first time the rail is expanded rather than while collapsed.
  useEffect(() => {
    if (collapsed) return
    loadRuns()
  }, [collapsed, loadRuns])

  useEffect(() => {
    if (!selectedId) return
    loadRunDetail(selectedId)
  }, [selectedId, loadRunDetail])

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    const active = selectedRun && ACTIVE_STATUSES.includes(selectedRun.status)
    if (!collapsed && selectedId && active) {
      pollRef.current = setInterval(() => {
        loadRunDetail(selectedId)
        loadRuns()
      }, 2000)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [collapsed, selectedId, selectedRun, loadRunDetail, loadRuns])

  async function submitRun() {
    const trimmed = goal.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/harness/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: trimmed }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: 'Run failed to start', description: data.error ?? 'Unknown error', variant: 'destructive' })
      } else {
        setGoal('')
        toast({ title: 'Run finished', description: `Status: ${data.run?.status ?? 'done'}` })
        await loadRuns()
        if (data.runId) {
          setSelectedId(data.runId)
          loadRunDetail(data.runId)
        }
      }
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const planSteps = useMemo<PlanStepMeta[]>(() => {
    const plan = (selectedRun as unknown as { plan?: { steps?: PlanStepMeta[] } } | null)?.plan
    return plan?.steps ?? []
  }, [selectedRun])

  const depMap = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of planSteps) m.set(s.label, s.dependsOn ?? [])
    return m
  }, [planSteps])

  // Top-level plan steps only (excludes loop-iteration/fan-out-child rows
  // like "tailor-top-10#3", and the separate planner journal row) — this is
  // the denominator the user actually plans against ("6 steps"), not an
  // inflated count that balloons every time a fan-out step spawns children.
  const topLevelSteps = useMemo(() => {
    if (planSteps.length === 0) return []
    const labels = new Set(planSteps.map((s) => s.label))
    return steps.filter((s) => labels.has(s.label))
  }, [steps, planSteps])

  // "Which agent is executing right now": the running top-level step(s) if
  // any (covers plain and fan-out steps — their own row's status flips to
  // 'running' for the whole step, not just its children), else fall back to
  // any running row at all so a loop step's in-flight iteration still shows
  // up as "still working" instead of the panel looking stalled.
  const runningNow = useMemo(() => {
    const topRunning = topLevelSteps.filter((s) => s.status === 'running')
    if (topRunning.length > 0) return topRunning
    return steps.filter((s) => s.status === 'running')
  }, [topLevelSteps, steps])

  const stepProgress = useMemo(
    () => ({
      total: topLevelSteps.length,
      completed: topLevelSteps.filter((s) => s.status === 'completed').length,
    }),
    [topLevelSteps]
  )

  // Desktop-only collapsed rail. Mobile never shows a persistent rail — see
  // the mobile branch below, which keeps AnimatePresence mounted across the
  // collapsed/open toggle so the drawer's exit (slide-out) actually plays
  // instead of vanishing when this early-return would otherwise unmount it.
  if (collapsed && !mobile) {
    return (
      <div className="flex w-11 shrink-0 flex-col items-center border-l pt-1">
        <Button variant="ghost" size="icon" onClick={onToggleCollapsed} aria-label="Expand runs panel">
          <PanelRightOpen className="h-[18px] w-[18px] text-muted-foreground" />
        </Button>
      </div>
    )
  }

  const panel = (
    <div className={cn('flex flex-col', mobile ? 'h-full w-full' : 'w-[320px] shrink-0 border-l pl-3')}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-display text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Runs
        </h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapsed}
          aria-label="Collapse runs panel"
          className="h-7 w-7"
        >
          <PanelRightClose className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      <div className="mb-3 space-y-2">
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Start a new agent run…"
          className="min-h-[56px] text-caption"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitRun()
          }}
        />
        <Button onClick={submitRun} disabled={submitting || !goal.trim()} size="sm" className="w-full">
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {submitting ? 'Running…' : 'New run'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin">
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No runs yet"
            body="Start one above — each run plans a DAG of specialized agents."
            className="px-3 py-8"
          />
        ) : (
          <>
            <div className="space-y-1.5">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(run.id)
                    setSelectedRun(run)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-control border bg-card px-2.5 py-2 text-left transition-colors hover:border-accent/40',
                    selectedId === run.id ? 'border-accent/60 shadow-card' : 'border-border'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-caption font-medium text-foreground">{run.goal}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {formatRelativeTime(run.created_at)}
                      <span>·</span>
                      {fmtTokens(run.spent_tokens)} tok
                    </div>
                  </div>
                  <RunStatusBadge status={run.status} className="shrink-0 text-[10px]" />
                </button>
              ))}
            </div>

            {selectedRun && (
              <div className="space-y-3 border-t pt-3">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-caption font-semibold text-foreground">Steps</h3>
                    <RunStatusBadge status={selectedRun.status} className="text-[10px]" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{selectedRun.goal}</p>

                  {/* LEGIBLE PROGRESS: which agent is executing, how far through the
                      plan the run is, and — this is the part that used to be a bare
                      "running…" — plainly say whether a non-active run will finish on
                      its own (incomplete) or needs a person (failed) or already did
                      what it could (completed_with_errors). */}
                  {selectedRun.status === 'planning' && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-accent-deep">
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      Planning the run…
                    </p>
                  )}
                  {selectedRun.status === 'running' && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-accent-deep">
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      <span className="truncate">
                        {runningNow.length > 0
                          ? `Running ${Array.from(new Set(runningNow.map((s) => s.agent_type))).join(', ')}`
                          : 'Working…'}
                      </span>
                      {stepProgress.total > 0 && (
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          · {stepProgress.completed}/{stepProgress.total} steps
                        </span>
                      )}
                    </p>
                  )}
                  {selectedRun.status === 'incomplete' && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <PauseCircle className="mt-px h-3 w-3 shrink-0" />
                      <span>
                        Paused at the time limit
                        {stepProgress.total > 0 && (
                          <span className="tabular-nums"> ({stepProgress.completed}/{stepProgress.total} steps done)</span>
                        )}{' '}
                        — it will pick back up and keep going automatically, no action needed.
                      </span>
                    </p>
                  )}
                  {selectedRun.status === 'failed' && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
                      <XCircle className="h-3 w-3 shrink-0" />
                      Failed — it will not retry on its own.
                    </p>
                  )}
                  {selectedRun.status === 'completed_with_errors' && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      Finished, but {stepProgress.total > 0 ? `only ${stepProgress.completed}/${stepProgress.total} steps` : 'not everything'} completed.
                    </p>
                  )}
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Token budget</span>
                    <span className="tabular-nums">
                      {fmtTokens(selectedRun.spent_tokens)} / {fmtTokens(selectedRun.budget_tokens)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{
                        width: `${Math.min(100, (selectedRun.spent_tokens / Math.max(1, selectedRun.budget_tokens)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Raw error detail: skipped for 'incomplete' — the progress line
                    above already explains the pause plainly, and the executor's
                    errorSummary for that status is informational, not a problem
                    (see lib/harness/executor.ts), so it doesn't belong in the
                    same red "something's wrong" treatment 'failed' and
                    'completed_with_errors' get. */}
                {selectedRun.error && selectedRun.status !== 'incomplete' && (
                  <div className="rounded-control bg-red-50 p-2 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                    {selectedRun.error}
                  </div>
                )}

                {steps.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">Planning…</p>
                ) : (
                  <ol className="space-y-1.5">
                    {steps.map((step) => {
                      const deps = depMap.get(step.label) ?? []
                      return (
                        <li key={step.id} className="rounded-control border border-border bg-background/40 p-2">
                          <div className="flex items-center gap-1.5">
                            <StepIcon status={step.status} />
                            <span className="rounded bg-sunken px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {step.agent_type}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                              {step.label}
                            </span>
                            {typeof step.tokens_used === 'number' && step.tokens_used > 0 && (
                              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {fmtTokens(step.tokens_used)}
                              </span>
                            )}
                          </div>
                          {deps.length > 0 && (
                            <div className="mt-1 flex flex-wrap items-center gap-1 pl-5 text-[10px] text-muted-foreground">
                              <ChevronRight className="h-2.5 w-2.5" />
                              after
                              {deps.map((d) => (
                                <span key={d} className="rounded bg-sunken px-1 py-0.5 font-mono">
                                  {d}
                                </span>
                              ))}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )

  if (!mobile) return panel

  // Mobile: AnimatePresence stays mounted across every render regardless of
  // `collapsed` — only its children's presence changes — so the drawer
  // actually slides out on close instead of the whole subtree vanishing
  // instantly (which is what an early `if (collapsed) return null` above
  // this point would cause).
  return (
    <AnimatePresence>
      {!collapsed && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitionFast}
            className="fixed inset-0 z-40 bg-foreground/40"
            onClick={onToggleCollapsed}
            aria-hidden="true"
          />
          <motion.div
            key="panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={transitionBase}
            role="dialog"
            aria-label="Agent runs"
            className="fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-sm flex-col border-l bg-card p-3 shadow-pop"
          >
            {panel}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
