// /api/scheduled-tasks
//
// GET   the person's Scheduled tasks, each with the lines its card shows (schedule, last result,
//       next time).
// POST  { name, instruction, schedule: { every, at?, weekday?, hours?, timezone }, autonomy?, rules? }
//
// The schedule is structured on purpose: code turns it into the cron string and the next time it
// is due, so nobody (and no model) writes cron. "act within my rules" is only set here, by the
// person, and a demo cannot schedule anything.

import { NextRequest, NextResponse } from 'next/server'
import { isDemoUser } from '@/lib/agents/api'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { cardLines, createScheduledTask, listScheduledTasks, ScheduleError } from '@/lib/agents/schedules'
import { CreateTaskBody, SCHEDULED_TASKS_ON } from '@/lib/agents/schedule-schemas'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!SCHEDULED_TASKS_ON) return new NextResponse(null, { status: 404 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const tasks = await listScheduledTasks(createAdminClient(), user.id)
  return NextResponse.json({ tasks: tasks.map((task) => ({ ...task, card: cardLines(task) })) })
}

export async function POST(request: NextRequest) {
  if (!SCHEDULED_TASKS_ON) return new NextResponse(null, { status: 404 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = CreateTaskBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body', fix: 'Send a name, an instruction and a schedule with every and timezone.' }, { status: 400 })

  const admin = createAdminClient()
  if (await isDemoUser(admin, user.id)) {
    return NextResponse.json({ error: 'Demo accounts cannot schedule tasks.', fix: 'This needs a full account.' }, { status: 403 })
  }

  try {
    const task = await createScheduledTask(admin, user.id, parsed.data)
    return NextResponse.json({ task: { ...task, card: cardLines(task) } }, { status: 201 })
  } catch (e) {
    if (e instanceof ScheduleError) return NextResponse.json({ error: e.message, fix: e.fix }, { status: 400 })
    throw e
  }
}
