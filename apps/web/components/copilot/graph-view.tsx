'use client'

// Pure presentational run-graph view: nodes by status (pending/running/
// completed/failed/skipped), dependency edges, loop iterations grouped under
// their parent, and fan-out children nested under theirs. Driven entirely by
// props (`steps` — an agent_steps snapshot — and optionally `plan`, the run's
// agent_runs.plan) — NO data fetching, no polling; whatever mounts this owns
// re-fetching agent_steps and passing fresh props, which is exactly what makes
// a GROWING graph (a mid-run replan appending steps, a loop adding another
// iteration, a fan-out's children completing one by one) show up here: this
// component just re-renders from whatever it's handed.
//
// NOT YET MOUNTED ANYWHERE — this file only exports the component. The
// natural host is components/copilot/runs-panel.tsx (owned by another
// workstream, off-limits here); wiring `<GraphView steps={...} plan={...} />`
// into it — most likely as an alternate view next to the existing flat step
// list — is left to whoever owns that file next.
//
// Edge geometry is measured from the real DOM (getBoundingClientRect via a
// ResizeObserver), not estimated from fixed card heights — node cards vary in
// height (nested loop/fan-out children, error text, etc.), so a layout that
// assumed a fixed height would draw edges that don't line up with the cards.
// Measuring is a rendering concern, not a data-fetching one; no network/DB
// calls happen anywhere in this file.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  GitBranch,
  Loader2,
  Repeat,
  XCircle,
} from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import type { AgentStepRow, Plan, PlanStep, StepStatus } from '@/lib/harness/types'

// --- layout constants ---------------------------------------------------

const COLUMN_GAP = 72
const ROW_GAP = 16
const NODE_WIDTH = 252

// --- status presentation --------------------------------------------------

const STATUS_TONE: Record<StepStatus, BadgeTone> = {
  pending: 'neutral',
  running: 'accent',
  completed: 'good',
  failed: 'bad',
  skipped: 'muted',
}

function StatusIcon({ status, className }: { status: StepStatus; className?: string }) {
  const cls = cn('h-3.5 w-3.5', className)
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-accent-deep')} />
    case 'failed':
      return <XCircle className={cn(cls, 'text-red-600 dark:text-red-400')} />
    case 'skipped':
      return <Ban className={cn(cls, 'text-muted-foreground')} />
    default:
      return <CircleDashed className={cn(cls, 'text-muted-foreground')} />
  }
}

/** Best-effort one-line synopsis of a step's output, generic across all 9
 *  agent_type shapes (mirrors the same spirit as step-card.tsx's
 *  formatObservation, kept independent since this component must stay
 *  self-contained / prop-driven). */
function stepDetail(step: AgentStepRow): string | null {
  const out = step.output as Record<string, unknown> | null | undefined
  if (step.status === 'failed') {
    return typeof out?.error === 'string' ? out.error : null
  }
  if (step.status === 'skipped') {
    if (typeof out?.skipped === 'string') return out.skipped
    if (typeof out?.skippedReason === 'string') return out.skippedReason
    return null
  }
  if (step.status !== 'completed' || !out) return null

  if (typeof out.fannedOut === 'number') {
    const failed = typeof out.failed === 'number' ? out.failed : 0
    return `${out.completed as number}/${out.fannedOut as number} completed${failed ? `, ${failed} failed` : ''}`
  }
  if (typeof out.skippedReason === 'string' && out.skippedReason) return out.skippedReason
  if (Array.isArray(out.topJobIds)) {
    const matches = Array.isArray(out.matches) ? out.matches.length : 0
    return `${matches} scored, ${out.topJobIds.length} above threshold`
  }
  if (Array.isArray(out.jobIds)) return `${out.jobIds.length} job(s)`
  if (typeof out.draftId !== 'undefined' && typeof out.status === 'string') return `draft: ${out.status}`
  if (typeof out.verified === 'boolean') {
    const issues = Array.isArray(out.issues) ? out.issues.length : 0
    return out.verified ? 'verified' : `${issues} issue(s)`
  }
  if (typeof out.resumeSummary === 'string') return 'CV tailored'
  if (typeof out.dossierId !== 'undefined') return out.hasSummary ? 'company research ready' : 'company research (partial)'
  if (typeof out.message === 'string') return out.message
  if (typeof out.kitId !== 'undefined') return `${(out.questionCount as number) ?? 0} question(s)`
  return null
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// --- grouping: top-level steps vs. loop-iteration / fan-out-child rows ------

interface StepGroup {
  step: AgentStepRow
  planStep?: PlanStep
  children: AgentStepRow[]
  kind: 'loop' | 'fanOut' | 'children' | 'plain'
}

function groupSteps(steps: AgentStepRow[], plan: Plan | null | undefined): {
  planningStep: AgentStepRow | null
  replanEvents: AgentStepRow[]
  groups: StepGroup[]
} {
  const planningStep =
    steps.find((s) => s.agent_type === 'planner' && !s.label.startsWith('__replan-')) ?? null
  const replanEvents = steps.filter((s) => s.agent_type === 'planner' && s.label.startsWith('__replan-'))

  const topLevel = steps.filter((s) => s.parent_step_id == null && s !== planningStep && !replanEvents.includes(s))
  const planByLabel = new Map((plan?.steps ?? []).map((s) => [s.label, s]))

  const groups: StepGroup[] = topLevel.map((step) => {
    const children = steps
      .filter((s) => s.parent_step_id === step.id)
      .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0))
    const planStep = planByLabel.get(step.label)
    const kind: StepGroup['kind'] =
      children.length === 0 ? 'plain' : planStep?.loop ? 'loop' : planStep?.fanOut ? 'fanOut' : 'children'
    return { step, planStep, children, kind }
  })

  // Orphans: a child whose parent row isn't in `topLevel` for some reason
  // (shouldn't happen, but never silently drop a journaled step).
  const claimedChildIds = new Set(groups.flatMap((g) => g.children.map((c) => c.id)))
  const orphans = steps.filter(
    (s) => s.parent_step_id != null && !claimedChildIds.has(s.id) && s !== planningStep && !replanEvents.includes(s)
  )
  for (const orphan of orphans) {
    groups.push({ step: orphan, children: [], kind: 'plain' })
  }

  return { planningStep, replanEvents, groups }
}

// --- dependency layering (only possible when `plan` is supplied) ------------

function layerGroups(groups: StepGroup[], plan: Plan | null | undefined): Map<string, number> {
  const layer = new Map<string, number>()
  if (!plan) {
    for (const g of groups) layer.set(g.step.label, 0)
    return layer
  }
  const labels = new Set(groups.map((g) => g.step.label))
  const depsByLabel = new Map(plan.steps.map((s) => [s.label, s.dependsOn]))

  function resolve(label: string, seen: Set<string>): number {
    if (layer.has(label)) return layer.get(label)!
    if (seen.has(label)) return 0 // defensive cycle guard; PlanSchema already forbids real cycles
    const deps = (depsByLabel.get(label) ?? []).filter((d) => labels.has(d) && d !== label)
    if (deps.length === 0) {
      layer.set(label, 0)
      return 0
    }
    const nextSeen = new Set(seen)
    nextSeen.add(label)
    const l = 1 + Math.max(...deps.map((d) => resolve(d, nextSeen)))
    layer.set(label, l)
    return l
  }

  for (const g of groups) resolve(g.step.label, new Set())
  return layer
}

// --- edge measurement (DOM-derived, not estimated) ---------------------------

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function useMeasuredRects(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLDivElement>())
  const [rects, setRects] = useState<Map<string, Rect>>(new Map())

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const containerBox = container.getBoundingClientRect()
    const next = new Map<string, Rect>()
    nodeRefs.current.forEach((el, label) => {
      const box = el.getBoundingClientRect()
      next.set(label, { x: box.left - containerBox.left, y: box.top - containerBox.top, w: box.width, h: box.height })
    })
    setRects(next)
  }, [])

  const registerNode = useCallback(
    (label: string) => (el: HTMLDivElement | null) => {
      if (el) nodeRefs.current.set(label, el)
      else nodeRefs.current.delete(label)
    },
    []
  )

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is an
  // intentionally caller-provided dependency array (steps/plan identity).
  useLayoutEffect(() => {
    measure()
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(container)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps])

  return { containerRef, registerNode, rects }
}

// --- nested loop / fan-out children -----------------------------------------

function ChildRow({ child }: { child: AgentStepRow }) {
  const detail = stepDetail(child)
  return (
    <div className="flex items-center gap-1.5 rounded bg-sunken/70 px-1.5 py-1 text-[10px]">
      <StatusIcon status={child.status} className="h-3 w-3 shrink-0" />
      <span className="shrink-0 tabular-nums text-muted-foreground">#{child.iteration ?? '?'}</span>
      {detail && <span className="min-w-0 truncate text-muted-foreground" title={detail}>{detail}</span>}
    </div>
  )
}

function ChildrenPanel({ group }: { group: StepGroup }) {
  const { children, kind } = group
  if (children.length === 0) return null
  const completed = children.filter((c) => c.status === 'completed').length
  const failed = children.filter((c) => c.status === 'failed').length

  return (
    <div className="border-t border-border/60 bg-background/40 px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {kind === 'loop' ? <Repeat className="h-3 w-3" /> : <GitBranch className="h-3 w-3" />}
        {kind === 'loop' ? 'loop iterations' : kind === 'fanOut' ? 'fan-out children' : 'children'}
        <span className="ml-auto normal-case tracking-normal">
          {completed}/{children.length}
          {failed ? ` · ${failed} failed` : ''}
        </span>
      </div>
      {kind === 'loop' ? (
        <div className="flex flex-col gap-1">
          {children.map((c) => (
            <ChildRow key={c.id} child={c} />
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {children.map((c) => (
            <ChildRow key={c.id} child={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// --- one DAG node -------------------------------------------------------

function GraphNode({
  group,
  registerRef,
  expanded,
  onToggle,
}: {
  group: StepGroup
  registerRef: (el: HTMLDivElement | null) => void
  expanded: boolean
  onToggle: () => void
}) {
  const { step, children } = group
  const detail = stepDetail(step)
  const hasChildren = children.length > 0

  return (
    <div
      ref={registerRef}
      style={{ width: NODE_WIDTH }}
      className={cn(
        'rounded-control border bg-card shadow-card',
        step.status === 'failed' ? 'border-red-300/70 dark:border-red-500/40' : 'border-border'
      )}
    >
      <button
        type="button"
        onClick={hasChildren ? onToggle : undefined}
        className={cn('flex w-full items-center gap-1.5 px-2.5 py-2 text-left', hasChildren && 'cursor-pointer')}
      >
        <StatusIcon status={step.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-foreground">{step.label}</span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">{step.agent_type}</span>
        </span>
        {typeof step.tokens_used === 'number' && step.tokens_used > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fmtTokens(step.tokens_used)}</span>
        )}
        {hasChildren &&
          (expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ))}
      </button>
      {detail && (
        <div className="border-t border-border/60 px-2.5 py-1.5">
          <p className="truncate text-[10px] text-muted-foreground" title={detail}>
            {detail}
          </p>
        </div>
      )}
      {hasChildren && expanded && <ChildrenPanel group={group} />}
    </div>
  )
}

// --- top-level component -----------------------------------------------

export interface GraphViewProps {
  /** Every agent_steps row for the run — top-level steps AND their loop
   *  iterations / fan-out children (parent_step_id distinguishes them). */
  steps: AgentStepRow[]
  /** The run's plan (agent_runs.plan). Optional: without it, nodes/status
   *  still render (grouped, single column) but dependency edges are omitted
   *  — a graceful degrade, never a crash, consistent with the rest of the
   *  harness's "missing upstream data is an expected state" contract. */
  plan?: Plan | null
  className?: string
}

export function GraphView({ steps, plan, className }: GraphViewProps) {
  const { planningStep, replanEvents, groups } = useMemo(() => groupSteps(steps, plan), [steps, plan])
  const layerByLabel = useMemo(() => layerGroups(groups, plan), [groups, plan])

  const [collapsedLabels, setCollapsedLabels] = useState<Set<string>>(new Set())
  const toggle = useCallback((label: string) => {
    setCollapsedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const columns = useMemo(() => {
    const byLayer = new Map<number, StepGroup[]>()
    for (const g of groups) {
      const l = layerByLabel.get(g.step.label) ?? 0
      const arr = byLayer.get(l) ?? []
      arr.push(g)
      byLayer.set(l, arr)
    }
    return [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([, arr]) => arr)
  }, [groups, layerByLabel])

  const edges = useMemo(() => {
    if (!plan) return []
    const labels = new Set(groups.map((g) => g.step.label))
    const list: { from: string; to: string }[] = []
    for (const step of plan.steps) {
      if (!labels.has(step.label)) continue
      for (const dep of step.dependsOn) {
        if (labels.has(dep)) list.push({ from: dep, to: step.label })
      }
    }
    return list
  }, [plan, groups])

  const { containerRef, registerNode, rects } = useMeasuredRects([steps, plan, collapsedLabels])

  const counts = useMemo(() => {
    const c = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 }
    for (const g of groups) c[g.step.status] += 1
    return c
  }, [groups])

  if (steps.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No steps yet"
        body="The graph fills in as the run plans and executes its steps."
        className={className}
      />
    )
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {planningStep && (
          <Badge tone={STATUS_TONE[planningStep.status]} className="text-[10px]">
            plan: {planningStep.status}
          </Badge>
        )}
        {(Object.entries(counts) as [StepStatus, number][])
          .filter(([, n]) => n > 0)
          .map(([status, n]) => (
            <Badge key={status} tone={STATUS_TONE[status]} className="text-[10px]">
              {n} {status}
            </Badge>
          ))}
      </div>

      <div ref={containerRef} className="relative overflow-x-auto scrollbar-thin">
        {/* text-* (not stroke-*) so the edge color always resolves — every
            theme token here already has a guaranteed `text-*` utility
            (used throughout this file for icons/labels), whereas a custom
            token is not guaranteed to also have a `stroke-*` utility
            generated depending on the Tailwind config's corePlugins scope. */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-border">
          {edges.map(({ from, to }) => {
            const a = rects.get(from)
            const b = rects.get(to)
            if (!a || !b) return null
            const x1 = a.x + a.w
            const y1 = a.y + a.h / 2
            const x2 = b.x
            const y2 = b.y + b.h / 2
            const mid = (x1 + x2) / 2
            return (
              <path
                key={`${from}->${to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              />
            )
          })}
        </svg>

        <div className="relative flex items-start" style={{ gap: COLUMN_GAP }}>
          {columns.map((col, i) => (
            <div key={i} className="flex flex-col" style={{ gap: ROW_GAP, width: NODE_WIDTH }}>
              {col.map((group) => (
                <GraphNode
                  key={group.step.id}
                  group={group}
                  registerRef={registerNode(group.step.label)}
                  expanded={group.children.length > 0 && !collapsedLabels.has(group.step.label)}
                  onToggle={() => toggle(group.step.label)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {replanEvents.length > 0 && (
        <div className="rounded-control border border-border bg-sunken/50 px-2.5 py-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Replan events — the graph grew mid-run
          </p>
          <div className="flex flex-col gap-1">
            {replanEvents.map((ev) => {
              const out = ev.output as { accepted?: boolean; reason?: string; addedLabels?: string[] } | null
              return (
                <div key={ev.id} className="flex items-start gap-1.5 text-[10px]">
                  <StatusIcon status={ev.status} className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="text-muted-foreground">
                    {out?.reason ?? ev.label}
                    {out?.addedLabels && out.addedLabels.length > 0 && (
                      <span className="ml-1 text-foreground">+ {out.addedLabels.join(', ')}</span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
