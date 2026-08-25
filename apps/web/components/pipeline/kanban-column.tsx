'use client'

import { useDroppable } from '@dnd-kit/core'
import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STAGE_META, type PipelineStage } from '@/lib/format'
import {
  ApplicationCard,
} from '@/components/pipeline/application-card'
import type { ApplicationWithJob } from '@/components/pipeline/utils'

export interface KanbanColumnProps {
  stage: PipelineStage
  applications: ApplicationWithJob[]
  onCardClick: (app: ApplicationWithJob) => void
  activeId: string | null
  /** True while any card is being dragged (drives empty-column affordance). */
  isDragActive: boolean
  /** Keyboard-accessible alternative to dragging — see application-card.tsx. */
  onMoveStage: (applicationId: string, stage: PipelineStage) => void
  /** True when this column is the one named by ?stage= — briefly highlighted as a scroll target. */
  isLinkedTarget?: boolean
}

/** One pipeline stage column: 3px stage bar, tinted count chip, sunken well. */
export function KanbanColumn({
  stage,
  applications,
  onCardClick,
  activeId,
  isDragActive,
  onMoveStage,
  isLinkedTarget = false,
}: KanbanColumnProps) {
  const meta = STAGE_META[stage]
  const { setNodeRef, isOver } = useDroppable({ id: stage })

  /**
   * An empty stage becomes a narrow rail instead of a full column.
   *
   * Seven full-width columns is more board than any real pipeline needs: this
   * account's stages are mostly empty, so the screen was ~2,100px of horizontal
   * scroll spent rendering the word "Empty" five times while the stages that
   * actually held something were squeezed. Condensing the empty ones gives that
   * width back to the stages with work in them.
   *
   * It expands again the moment a drag starts, because an empty stage is
   * precisely where you most need to drop a card — a 56px rail would be a
   * cruelly small target. `isOver` also forces it open so the drop feedback is
   * legible under the cursor.
   */
  const condensed = applications.length === 0 && !isDragActive && !isOver

  if (condensed) {
    return (
      <div
        id={`stage-${stage}`}
        ref={setNodeRef}
        className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-card border bg-card/60 shadow-card"
      >
        <div className={cn('h-[3px] w-full', meta.barClass)} />
        <div className="flex flex-1 flex-col items-center gap-2.5 py-3">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', meta.dotClass)} aria-hidden />
          {/* Still a real h2 so the board's heading outline is unchanged whether
              or not a stage happens to be empty. Rotated rather than truncated:
              a vertical label stays fully readable, an abbreviated one does not. */}
          <h2 className="whitespace-nowrap text-caption font-medium text-muted-foreground [writing-mode:vertical-rl]">
            {meta.label}
          </h2>
          <span className="mt-auto font-readout text-caption tabular-nums text-muted-foreground/70">
            0
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      id={`stage-${stage}`}
      className={cn(
        // GROWS to share the board's width instead of sitting at a fixed 288px.
        // Seven `w-72 shrink-0` columns came to ~2,100px regardless of the
        // viewport, so even a wide screen showed four and a half columns and
        // made the rest a horizontal scroll — while each visible column was
        // narrower than the job titles it had to hold. `basis-72 grow` keeps 288
        // as the FLOOR and lets columns expand into whatever space there is, so
        // the board fits without scrolling on a normal desktop and the cards get
        // room to breathe.
        // GROWS to share the board's width instead of sitting at a fixed 288px.
        // Seven `w-72 shrink-0` columns came to ~2,100px regardless of the
        // viewport, so even a wide screen showed four and a half and made the
        // rest a horizontal scroll — while each visible column was narrower than
        // the job titles it had to hold. `flex-1` with a 15rem floor lets the
        // stages that hold work expand into whatever width the condensed empty
        // stages just gave back.
        // 13rem floor, not 15: five populated stages at 240px plus two condensed
        // rails and the gaps came to ~1,384px against ~1,300px of board, so the
        // last column clipped at the viewport edge. 208px still comfortably fits
        // a company name and a score chip on one line.
        'flex min-w-[13rem] flex-1 flex-col overflow-hidden rounded-card border bg-card shadow-card transition-shadow',
        isOver && 'shadow-pop ring-2 ring-accent/30',
        isLinkedTarget && 'ring-2 ring-accent'
      )}
    >
      <div className={cn('h-[3px]', meta.barClass)} />
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full', meta.dotClass)} aria-hidden />
          {/* h2: first heading-bearing element after the page's h1 — each column is
              a peer section of the board, not a subsection of one preceding it. */}
          <h2 className="text-body font-medium text-foreground">{meta.label}</h2>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-caption font-medium tabular-nums',
            meta.chipClass
          )}
        >
          {applications.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          'min-h-[180px] max-h-[calc(100vh-320px)] space-y-2 overflow-y-auto bg-sunken p-2 transition-colors',
          isOver && 'bg-muted/80'
        )}
      >
        {applications.map((app) => (
          <ApplicationCard
            key={app.id}
            application={app}
            onClick={() => onCardClick(app)}
            isDragging={activeId === app.id}
            onMoveStage={(newStage) => onMoveStage(app.id, newStage)}
          />
        ))}

        {applications.length === 0 &&
          (isDragActive ? (
            <div
              className={cn(
                'flex h-24 flex-col items-center justify-center gap-1 rounded-card border-2 border-dashed text-caption transition-colors',
                isOver
                  ? 'border-accent bg-accent-soft text-accent-deep'
                  : 'border-border text-muted-foreground'
              )}
            >
              {/* .drop-nudge, not animate-bounce: Tailwind's bounce overshoots
                  and snaps back, which reads as tacky on a control the user is
                  mid-gesture with. See globals.css. */}
              <ArrowDown className={cn('h-4 w-4', isOver && 'drop-nudge')} />
              Drop here
            </div>
          ) : (
            <div className="py-8 text-center text-caption text-muted-foreground">Empty</div>
          ))}
      </div>
    </div>
  )
}
