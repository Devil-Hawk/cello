// The advancer: moves one application one bounded step. The minute sweeper posts a due application
// here (reason advance on /api/agent/continue) and this runs the next step for it.
//
// ponytail: base resume only. Until K18's steps arrive, a preparing application goes straight to
// Ready with the base resume, so an Apply never strands between Preparing and Ready.

import type { SupabaseClient } from '@supabase/supabase-js'
import { DOORS } from '@/lib/pipeline/actors'
import { transition, type MoveResult } from '@/lib/pipeline/transition'

export async function advanceOne(admin: SupabaseClient, applicationId: string): Promise<MoveResult | null> {
  const { data: a } = await admin.from('applications').select('id, state, last_event_at').eq('id', applicationId).maybeSingle()
  const row = a as { id: string; state: string | null; last_event_at: string | null } | null
  if (!row || row.state !== 'preparing') return null
  return transition(admin, {
    applicationId: row.id,
    from: ['preparing'],
    to: 'ready',
    step: 'Using your base resume',
    event: {
      kind: 'step.finished',
      actor: DOORS.routine.actor,
      channel: DOORS.routine.channel,
      sentence: 'Cello is using your base resume. It is ready for you to send.',
      idempotencyKey: `advance:${row.id}:${row.last_event_at ?? 'none'}`,
    },
  })
}
