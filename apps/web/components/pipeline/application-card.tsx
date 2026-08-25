'use client'

import { useState } from 'react'
import { ArrowRightLeft, Building2, Check, ClipboardCheck, GripVertical, Mail } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { formatShortDate, matchTone, STAGE_META, type PipelineStage } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CompanyLogo } from '@/components/companies/company-logo'
import { LogApplicationDialog } from '@/components/pipeline/log-application-dialog'
import {
  type ApplicationWithJob,
  getDaysSinceUpdate,
  getGmailUrl,
  getPipelineAlert,
} from '@/components/pipeline/utils'

const ALL_STAGES: readonly PipelineStage[] = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
  'ghosted',
  'rejected',
]

/** Inner card content, shared by the draggable card and the drag overlay. */
export function ApplicationCardContent({
  application,
  className,
  showGrip = false,
}: {
  application: ApplicationWithJob
  className?: string
  /** Show a drag-handle affordance on hover — off for the static drag-overlay clone. */
  showGrip?: boolean
}) {
  const job = application.jobs
  const company = job?.companies
  const daysSinceUpdate = getDaysSinceUpdate(application.updated_at)
  const alert = getPipelineAlert(application)
  const gmailUrl = getGmailUrl(application)
  const tone = matchTone(job?.match_score ?? null)

  const logoSrc =
    company?.logo_url ||
    (company?.domain
      ? `https://www.google.com/s2/favicons?domain=${company.domain}&sz=128`
      : null)

  return (
    <div className={cn('group/card relative rounded-card border bg-card p-3 shadow-card', className)}>
      {showGrip && (
        <GripVertical
          className="absolute right-2 top-2 h-3.5 w-3.5 text-muted-foreground/40 opacity-0 transition-opacity group-hover/card:opacity-100"
          aria-hidden
        />
      )}
      <div className="flex items-start gap-2.5 pr-3">
        {logoSrc ? (
          <CompanyLogo src={logoSrc} name={company?.name || ''} className="h-8 w-8" />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border bg-sunken">
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          {/* h3: the kanban column header above each stack of cards is h2
              (see kanban-column.tsx), so a card title one level down is h3. */}
          <h3 className="truncate text-body font-medium text-foreground">
            {job?.title || 'Unknown Job'}
          </h3>
          <p className="truncate text-caption text-muted-foreground">
            {company?.name || 'Unknown Company'}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span
          className="text-caption text-muted-foreground"
          title={
            application.applied_at
              ? `Applied ${new Date(application.applied_at).toLocaleDateString()}`
              : undefined
          }
        >
          {application.applied_at
            ? `Applied ${formatShortDate(application.applied_at)}`
            : daysSinceUpdate === 0
              ? 'Today'
              : `${daysSinceUpdate}d ago`}
        </span>

        <span className="flex items-center gap-1.5">
          {gmailUrl ? (
            <a
              href={gmailUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="rounded-control p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Open email in Gmail"
            >
              <Mail className="h-3.5 w-3.5" />
              <span className="sr-only">Open email thread in Gmail</span>
            </a>
          ) : application.source === 'gmail_sync' ? (
            <span title="Synced from Gmail">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="sr-only">Synced from Gmail</span>
            </span>
          ) : null}

          {tone !== 'none' && (
            <Badge tone={tone} className="px-1.5 tabular-nums">
              {job?.match_score}%
            </Badge>
          )}

          {alert && (
            <Badge tone={alert.kind === 'ghosted' ? 'bad' : 'warn'} title={alert.title}>
              {alert.label}
            </Badge>
          )}
        </span>
      </div>
    </div>
  )
}

export interface ApplicationCardProps {
  application: ApplicationWithJob
  onClick: () => void
  isDragging?: boolean
  /**
   * Keyboard/mouse-agnostic path to move a card between stages — the
   * pipeline board's drag-and-drop is otherwise pointer-only. Omit to hide
   * the menu (e.g. the static DragOverlay clone never needs it).
   */
  onMoveStage?: (stage: PipelineStage) => void
}

/**
 * Draggable kanban card. The drag affordance (mouse-only, via dnd-kit
 * pointer listeners) lives on the card body; the "Move to" menu is a real,
 * separately-focusable button so keyboard users have a full alternative to
 * dragging. Deliberately does NOT spread dnd-kit's `attributes` (which add
 * role="button" + tabIndex to the whole card) — combined with the real
 * buttons below that would be an axe "nested-interactive" violation. Pointer
 * dragging only needs the `listeners` (onPointerDown etc.), not the ARIA role.
 */
export function ApplicationCard({ application, onClick, isDragging, onMoveStage }: ApplicationCardProps) {
  const { listeners, setNodeRef, transform } = useDraggable({
    id: application.id,
    data: { application },
  })
  // Self-contained: the card owns this dialog's open state so "I already
  // applied" works from the kanban board directly, without the page needing
  // to know about receipts at all.
  const [logDialogOpen, setLogDialogOpen] = useState(false)

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  }

  const job = application.jobs
  const currentStage = application.stage as PipelineStage
  const cardLabel = `${job?.title || 'Unknown job'} at ${job?.companies?.name || 'unknown company'}, currently in ${STAGE_META[currentStage]?.label ?? currentStage}`

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      // Lets an ancestor find this exact card again after it moves — the
      // kanban board re-parents a moved card from one stage column's DOM
      // subtree to another's (they're sibling <KanbanColumn>s, not one
      // reordered list), which unmounts and remounts the card and destroys
      // whatever inside it held keyboard focus. See pipeline/page.tsx's
      // pendingFocusId effect, which uses this attribute to restore focus
      // after a menu-driven move.
      data-application-id={application.id}
      className="group/dragcard relative animate-fade-in cursor-grab active:cursor-grabbing"
    >
      {/* Real, focusable "open details" control — covers the visible card
          surface but is a semantic <button>, not the draggable div itself. */}
      <button
        type="button"
        onClick={() => {
          // Only open the detail dialog when not mid-drag.
          if (!transform) onClick()
        }}
        aria-label={cardLabel}
        className="block w-full rounded-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ApplicationCardContent
          application={application}
          showGrip
          className={cn(
            'pointer-events-none transition-all duration-150 group-hover/dragcard:-translate-y-0.5 group-hover/dragcard:shadow-pop',
            isDragging && 'shadow-pop ring-2 ring-accent/30'
          )}
        />
      </button>

      {onMoveStage && (
        <div
          className="absolute bottom-2.5 right-2.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/dragcard:opacity-100"
          // Stop the drag-handle pointer listeners on the card wrapper from
          // intercepting clicks meant for this menu.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Move ${job?.title || 'this application'} to a different stage`}
                data-move-stage-trigger
                className="rounded-control border bg-card p-1 text-muted-foreground shadow-card transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {ALL_STAGES.map((stage) => (
                <DropdownMenuItem
                  key={stage}
                  disabled={stage === currentStage}
                  onClick={() => onMoveStage(stage)}
                >
                  <span className={cn('mr-2 h-2 w-2 rounded-full', STAGE_META[stage].dotClass)} aria-hidden />
                  {STAGE_META[stage].label}
                  {stage === currentStage && <Check className="ml-auto h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {/* The manual receipt path — works with zero Gmail access. See
                  components/pipeline/log-application-dialog.tsx. */}
              <DropdownMenuItem onClick={() => setLogDialogOpen(true)}>
                <ClipboardCheck className="mr-2 h-3.5 w-3.5" />
                I already applied…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Stage/receipt changes land in the DB immediately; the board's local
          list catches up on next fetch (same as every other external
          mutation here — this component has no reach into the page's
          fetchApplications). The dialog's own toast confirms success in the
          meantime. */}
      <LogApplicationDialog open={logDialogOpen} onOpenChange={setLogDialogOpen} application={application} />
    </div>
  )
}

/** Card rendered inside the DragOverlay: pop shadow + slight tilt. */
export function ApplicationCardOverlay({ application }: { application: ApplicationWithJob }) {
  return (
    <ApplicationCardContent
      application={application}
      className="w-64 rotate-2 shadow-pop ring-2 ring-accent/40"
    />
  )
}
