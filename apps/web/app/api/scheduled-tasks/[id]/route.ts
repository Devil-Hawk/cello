// /api/scheduled-tasks/[id]
//
// PATCH  { name?, instruction?, schedule?, autonomy?, rules?, status? }  change a task; a new
//        schedule or resuming a paused task recomputes when it is next due.
// DELETE remove a task. Its conversation and anything it made stay.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { cardLines, deleteScheduledTask, ScheduleError, updateScheduledTask } from '@/lib/agents/schedules'
import { PatchTaskBody, SCHEDULED_TASKS_ON } from '@/lib/agents/schedule-schemas'

export const dynamic = 'force-dynamic'

const NOT_FOUND = { error: 'Not found', fix: 'Open Scheduled tasks and choose one from the list.' }

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!SCHEDULED_TASKS_ON) return new NextResponse(null, { status: 404 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = PatchTaskBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body', fix: 'Send at least one field to change.' }, { status: 400 })

  try {
    const task = await updateScheduledTask(createAdminClient(), user.id, params.id, parsed.data)
    if (!task) return NextResponse.json(NOT_FOUND, { status: 404 })
    return NextResponse.json({ task: { ...task, card: cardLines(task) } })
  } catch (e) {
    if (e instanceof ScheduleError) return NextResponse.json({ error: e.message, fix: e.fix }, { status: 400 })
    throw e
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!SCHEDULED_TASKS_ON) return new NextResponse(null, { status: 404 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const removed = await deleteScheduledTask(createAdminClient(), user.id, params.id)
  return removed ? NextResponse.json({ deleted: true }) : NextResponse.json(NOT_FOUND, { status: 404 })
}
