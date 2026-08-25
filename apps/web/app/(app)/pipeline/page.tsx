'use client'

import { LogoMark } from '@/components/brand/logo'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { motion } from '@/components/ui/motion'
import { FileWarning, KanbanSquare } from 'lucide-react'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { EmptyStateHero } from '@/components/ui/empty-state-hero'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { STAGE_META, type PipelineStage } from '@/lib/format'
import { cn } from '@/lib/utils'
import { KanbanColumn } from '@/components/pipeline/kanban-column'
import { ApplicationCardOverlay } from '@/components/pipeline/application-card'
import { ApplicationDetailDialog } from '@/components/pipeline/application-detail-dialog'
import { PipelineEmptyPreview } from '@/components/pipeline/empty-preview'
import type { ApplicationWithJob } from '@/components/pipeline/utils'

// The kanban renders exactly these 7 stages (STAGE_META order).
const STAGES: readonly PipelineStage[] = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
  'ghosted',
  'rejected',
]

function PipelinePageSkeleton() {
  return (
    <div className="space-y-6">
      {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
      <div className="flex items-center gap-3">
        <LogoMark className="h-7 w-7" loading />
        <h1 className="sr-only">Pipeline — loading…</h1>
        <span className="text-caption text-muted-foreground">Loading your pipeline…</span>
      </div>
      <div>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-72 w-72 shrink-0 rounded-card" />
        ))}
      </div>
    </div>
  )
}

export default function PipelinePage() {
  return (
    <Suspense fallback={<PipelinePageSkeleton />}>
      <PipelinePageInner />
    </Suspense>
  )
}

function PipelinePageInner() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const [applications, setApplications] = useState<ApplicationWithJob[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedApplication, setSelectedApplication] = useState<ApplicationWithJob | null>(null)
  const [dateFilter, setDateFilter] = useState<string>('all') // 'all' or 'YYYY-MM'
  // Announced politely to screen readers on every stage change (drag OR the
  // keyboard "Move to stage" menu) — otherwise a move is silent for anyone
  // not looking at the board. See the aria-live region near the bottom.
  const [moveAnnouncement, setMoveAnnouncement] = useState('')
  // Set only when a card is moved via the keyboard-accessible "Move to
  // stage" menu (never by drag — a mouse drag never had keyboard focus to
  // restore). The moved card unmounts from its source column and remounts
  // in the destination column (they're sibling <KanbanColumn>s, each with
  // their own application list, not one reordered list) — that remount
  // destroys the DOM node the "Move to stage" trigger's Radix menu would
  // otherwise try to refocus, so focus silently falls to <body>. The effect
  // below re-finds the card by data-application-id once it has re-rendered
  // in its new column and focuses its trigger explicitly.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null)

  // Deep link from the Insights funnel chart: /pipeline?stage=interview
  // scrolls to and briefly rings that column instead of doing nothing.
  const linkedStage = searchParams.get('stage')
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (!linkedStage || scrolledRef.current || isLoading) return
    const el = document.getElementById(`stage-${linkedStage}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
      scrolledRef.current = true
    }
  }, [linkedStage, isLoading])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    // Keyboard alternative to pointer dragging: focus a card's drag handle,
    // Space/Enter to lift it, arrow keys to move, Space/Enter to drop,
    // Escape to cancel. Collision detection (closestCenter, below) resolves
    // which column a keyboard-lifted card lands in exactly like a mouse drop.
    useSensor(KeyboardSensor)
  )

  const fetchApplications = useCallback(async () => {
    // setIsLoading matters on RETRY: without it the retry clears loadError
    // while isLoading is already false, so the "Your board is ready" hero
    // flashes for the length of the refetch.
    setIsLoading(true)
    setLoadError(null)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setLoadError("Couldn't verify your session. Sign in again and try again.")
        return
      }

      const { data, error } = await supabase
        .from('applications')
        .select('*, jobs(id, title, url, match_score, companies(name, domain, logo_url))')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })

      if (error) {
        console.error('Error fetching applications:', error)
        setLoadError("Couldn't load your pipeline. Check your connection and try again.")
        return
      }

      setApplications(data as unknown as ApplicationWithJob[])
    } catch (e) {
      // A thrown failure never produces a Supabase `{ error }` object, so
      // checking only that left a hard load failure rendering the
      // "Your board is ready" hero — an empty board is not a failed one.
      console.error('Error fetching applications:', e)
      setLoadError("Couldn't load your pipeline. Check your connection and try again.")
    } finally {
      setIsLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    fetchApplications()
  }, [fetchApplications])

  // Unique months (from applied_at) for the filter dropdown
  const availableMonths = [
    ...new Set(
      applications
        .filter((app) => app.applied_at)
        .map((app) => {
          const date = new Date(app.applied_at!)
          return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
        })
    ),
  ]
    .sort()
    .reverse()

  const filteredApplications =
    dateFilter === 'all'
      ? applications
      : applications.filter((app) => {
          if (!app.applied_at) return false
          const date = new Date(app.applied_at)
          const appMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
          return appMonth === dateFilter
        })

  const applicationsByStage = STAGES.reduce(
    (acc, stage) => {
      acc[stage] = filteredApplications.filter((app) => app.stage === stage)
      return acc
    },
    {} as Record<PipelineStage, ApplicationWithJob[]>
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  /**
   * Single path for changing an application's stage — driven by either a
   * pointer/keyboard drag-end or the card's "Move to stage" menu, so both
   * ways of moving a card optimistically update, persist, revert-on-error,
   * and announce identically.
   */
  const moveApplicationToStage = useCallback(
    async (appId: string, newStage: string) => {
      const application = applications.find((app) => app.id === appId)
      if (!application || application.stage === newStage) return

      const stageLabel = STAGE_META[newStage as PipelineStage]?.label ?? newStage
      const title = application.jobs?.title ?? 'Application'

      // Optimistically update UI
      setApplications((prev) =>
        prev.map((app) =>
          app.id === appId
            ? { ...app, stage: newStage, updated_at: new Date().toISOString() }
            : app
        )
      )
      setMoveAnnouncement(`Moved ${title} to ${stageLabel}`)

      // Persist stage change
      const { error } = await supabase
        .from('applications')
        .update({ stage: newStage, updated_at: new Date().toISOString() })
        .eq('id', appId)

      if (error) {
        console.error('Error updating application stage:', error)
        setMoveAnnouncement(`Couldn't move ${title} — reverted`)
        // Visible counterpart to the sr-only announcement above — a sighted
        // user watching the card snap back needs to know why, not just
        // assistive tech.
        toast({
          title: 'Move failed',
          description: `${title} couldn't be moved to ${stageLabel}. It's been reverted.`,
          variant: 'destructive',
        })
        // Revert on error
        fetchApplications()
      }
    },
    [applications, supabase, fetchApplications]
  )

  /**
   * The one path that reaches moveApplicationToStage via a real keyboard
   * interaction (the card's "Move to stage" menu) rather than a pointer
   * drag — see the pendingFocusId doc above for why only this path needs to
   * remember which card to refocus.
   */
  const handleMoveStageViaMenu = useCallback(
    (appId: string, newStage: PipelineStage) => {
      setPendingFocusId(appId)
      moveApplicationToStage(appId, newStage)
    },
    [moveApplicationToStage]
  )

  // Runs after a menu-driven move re-renders the board (the moved card is
  // now mounted in its destination column). Re-finds it by
  // data-application-id and focuses its "Move to stage" trigger — the
  // closest available stand-in for "focus stayed where the user was",
  // since the actual DOM node they had focused no longer exists.
  useEffect(() => {
    if (!pendingFocusId) return
    const card = document.querySelector<HTMLElement>(`[data-application-id="${pendingFocusId}"]`)
    const trigger = card?.querySelector<HTMLButtonElement>('[data-move-stage-trigger]')
    trigger?.focus()
    setPendingFocusId(null)
  }, [applications, pendingFocusId])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (!over) return
    moveApplicationToStage(active.id as string, over.id as string)
  }

  const activeApplication = activeId
    ? applications.find((app) => app.id === activeId)
    : null

  const totalApplications = filteredApplications.length

  if (isLoading) {
    return <PipelinePageSkeleton />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-display text-title text-foreground">Pipeline</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Drag cards between stages to keep your applications up to date.
          </p>
        </div>
        {applications.length > 0 && (
          <Select value={dateFilter} onValueChange={setDateFilter}>
            <SelectTrigger className="w-[190px]" aria-label="Filter by month applied">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time ({applications.length})</SelectItem>
              {availableMonths.map((month) => {
                const [year, m] = month.split('-')
                const monthName = new Date(parseInt(year), parseInt(m) - 1).toLocaleString(
                  'default',
                  { month: 'short' }
                )
                const count = applications.filter((app) => {
                  if (!app.applied_at) return false
                  const d = new Date(app.applied_at)
                  return (
                    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === month
                  )
                }).length
                return (
                  <SelectItem key={month} value={month}>
                    {monthName} {year} ({count})
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}
      </div>

      {loadError ? (
        <EmptyState
          icon={FileWarning}
          title="Couldn't load your pipeline"
          body={loadError}
          action={<Button onClick={fetchApplications}>Retry</Button>}
        />
      ) : totalApplications === 0 ? (
        applications.length === 0 ? (
          <EmptyStateHero
            icon={KanbanSquare}
            eyebrow="Pipeline · standing by"
            title="Your board is ready"
            body="Add a role to your pipeline and it lands in Discovered. Drag it across the stages as things move — Cello flags anything going quiet."
            action={
              <>
                <Button asChild>
                  <a href="/jobs">Browse jobs</a>
                </Button>
                <Button variant="outline" asChild>
                  <a href="/companies">Add a company</a>
                </Button>
              </>
            }
            preview={<PipelineEmptyPreview />}
            className="min-h-[26rem]"
          />
        ) : (
          <EmptyState
            icon={KanbanSquare}
            title="Nothing in this month"
            body="No applications match the selected month — try another filter."
            action={
              <Button variant="outline" onClick={() => setDateFilter('all')}>
                Show all time
              </Button>
            }
          />
        )
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {/* `items-start` so a short column does not stretch to match the
              tallest one, and the wrappers below flex instead of shrink-0 —
              see the comment on the wrapper. */}
          <div className="flex items-start gap-3 overflow-x-auto pb-4">
            {STAGES.map((stage, i) => (
              <motion.div
                key={stage}
                // `flex min-w-0` here is what actually sizes the board. This
                // wrapper used to be `shrink-0`, which pinned every column to
                // its intrinsic width no matter how much room the board had —
                // and because the wrapper sat between the flex row and the
                // column, the column's own flex rules could never take effect.
                // Seven rigid columns came to ~2,100px, so the board was a
                // horizontal scroll on any screen while each column was still
                // too narrow for the job titles inside it. Populated stages now
                // share the width; empty ones collapse to a rail (KanbanColumn).
                // A stage KanbanColumn will render as a condensed rail must not
                // be stretched by this wrapper, or the rail would be as wide as
                // a real column and nothing would be saved. Same condition as
                // the one in KanbanColumn, kept here because only the wrapper
                // can decide whether to take flex space.
                className={cn(
                  'flex min-w-0',
                  (applicationsByStage[stage] || []).length === 0 && activeId === null
                    ? 'shrink-0'
                    : 'flex-1'
                )}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: i * 0.03 }}
              >
                <KanbanColumn
                  stage={stage}
                  applications={applicationsByStage[stage] || []}
                  onCardClick={setSelectedApplication}
                  activeId={activeId}
                  isDragActive={activeId !== null}
                  onMoveStage={handleMoveStageViaMenu}
                  isLinkedTarget={linkedStage === stage}
                />
              </motion.div>
            ))}
          </div>

          <DragOverlay>
            {activeApplication && <ApplicationCardOverlay application={activeApplication} />}
          </DragOverlay>
        </DndContext>
      )}

      <ApplicationDetailDialog
        application={selectedApplication}
        onClose={() => setSelectedApplication(null)}
      />

      {/* Polite live region: announces every stage change (drag or the "Move
          to stage" menu) to screen readers, since the board itself gives no
          other non-visual signal that anything happened. */}
      <div role="status" aria-live="polite" className="sr-only">
        {moveAnnouncement}
      </div>
    </div>
  )
}
