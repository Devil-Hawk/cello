'use client'

// The Board (blueprint 4.8): stage columns. On a laptop a card drags to another column; on a phone the same columns
// scroll sideways and Move to on each card does the same. Closed takes no drop, because not selected and you
// withdrew are different facts and Move to names which. Loaded when the Board is first opened (applications-view.tsx).

import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import { RoleTitle } from '@/components/roles/role-tile'
import { COLUMNS, MOVE_TO, company, companyId, type AppRow } from './applications-view'

function BoardCard({ r, onMove }: { r: AppRow; onMove: (id: string, stage: string) => void }) {
  // Drag is for a laptop; the handle is hidden on a phone, where Move to does the same
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: r.id })
  return (
    <li ref={setNodeRef} style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined} className={`r-sheet relative space-y-2 p-3${isDragging ? ' z-10 opacity-80' : ''}`}>
      <button type="button" aria-label={`Drag ${r.jobs?.title ?? 'this application'} to another stage`} className="absolute right-1 top-1 hidden min-h-11 min-w-11 touch-none cursor-grab items-center justify-center md:inline-flex" {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      <RoleTitle id={r.job_id} title={r.jobs?.title ?? 'A role'} company={company(r)} companyId={companyId(r)} />
      <label className="block">
        <span className="r-meta block">Move to</span>
        <select className="r-field min-h-11 w-full" value={r.stage} onChange={(e) => onMove(r.id, e.target.value)}>
          {MOVE_TO.map((m) => <option key={m.stage} value={m.stage}>{m.label}</option>)}
          {!MOVE_TO.some((m) => m.stage === r.stage) && <option value={r.stage}>{r.stage}</option>}
        </select>
      </label>
    </li>
  )
}

/** A board column that takes a dropped card. Closed takes none: not selected and withdrew are different facts, so Move to names which. */
function BoardColumn({ c, items, onMove }: { c: (typeof COLUMNS)[number]; items: AppRow[]; onMove: (id: string, stage: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: c.id, disabled: c.id === 'closed' })
  return (
    <section ref={setNodeRef} aria-labelledby={`c-${c.id}`} className={`w-72 flex-none rounded-[12px]${isOver ? ' ring-2 ring-[var(--r-ink)]' : ''}`}>
      <h2 id={`c-${c.id}`} className="r-title mb-2">{c.label} ({items.length})</h2>
      <ul className="min-h-24 space-y-3">{items.map((r) => <BoardCard key={r.id} r={r} onMove={onMove} />)}</ul>
    </section>
  )
}


export function Board({ rows, onMove }: { rows: AppRow[]; onMove: (id: string, stage: string) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor))
  function dropped(e: DragEndEvent) {
    const to = COLUMNS.find((c) => c.id === e.over?.id)
    const r = rows.find((x) => x.id === e.active.id)
    if (to && r && !to.stages.includes(r.stage)) onMove(r.id, to.stages[0])
  }
  return (
    <DndContext sensors={sensors} onDragEnd={dropped}>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {COLUMNS.map((c) => <BoardColumn key={c.id} c={c} items={rows.filter((r) => c.stages.includes(r.stage))} onMove={onMove} />)}
      </div>
    </DndContext>
  )
}
