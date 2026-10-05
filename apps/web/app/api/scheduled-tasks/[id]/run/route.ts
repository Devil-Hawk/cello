// POST /api/scheduled-tasks/[id]/run: Run now. Starts the task straight away, whatever its
// schedule says (even a paused one), without moving its schedule. It answers 202 once the
// request to start is sent; the work shows up in the task list and in Needs you.

import { NextRequest, NextResponse } from 'next/server'
import { isDemoUser } from '@/lib/agents/api'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getScheduledTask } from '@/lib/agents/schedules'
import { fireContinue } from '@/lib/agents/scheduler'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const task = await getScheduledTask(admin, user.id, params.id)
  if (!task) return NextResponse.json({ error: 'Not found', fix: 'Open Scheduled tasks and choose one from the list.' }, { status: 404 })
  if (await isDemoUser(admin, user.id)) {
    return NextResponse.json({ error: 'Demo accounts cannot run scheduled tasks.', fix: 'This needs a full account.' }, { status: 403 })
  }

  await fireContinue({ reason: 'due', scheduled_task_id: task.id, force: true })
  return NextResponse.json({ started: true }, { status: 202 })
}
