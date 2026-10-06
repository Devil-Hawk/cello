// A test double for ApplyPort over the fake admin client: events land in `pipeline_events` the way the pipeline's
// functions write them, so status-turn tests run before K13 and K20 are on main. It keeps the two rules a test leans on:
// the same idempotency key returns the first event, and the person's own kinds are refused for anyone else.
// It is not a lane stub: it stays after the real adapter lands.

import type { AdminClient } from '@/lib/harness/types'
import { PERSON_ONLY_KINDS, type PipelineEvent } from '@/lib/pipeline/types'
import type { ApplyPort } from './apply'

export function applyFake(db: AdminClient): ApplyPort {
  const replayed = async (userId: string, key: string) => ((await db.from('pipeline_events').select('*').eq('user_id', userId).eq('idempotency_key', key).maybeSingle()).data as PipelineEvent | null) ?? null

  const recordEvent: ApplyPort['recordEvent'] = async (input) => {
    if (input.actor !== 'person' && PERSON_ONLY_KINDS.includes(input.kind)) throw new Error(`${input.kind} is the person's alone`)
    const first = await replayed(input.userId, input.idempotencyKey)
    if (first) return first
    const { data, error } = await db
      .from('pipeline_events')
      .insert({
        user_id: input.userId,
        application_id: input.applicationId,
        kind: input.kind,
        actor: input.actor,
        channel: input.channel ?? null,
        sentence: input.sentence.slice(0, 280),
        payload: input.payload ?? {},
        origin: input.origin ?? 'code',
        idempotency_key: input.idempotencyKey,
        from_state: null,
        to_state: null,
        created_at: new Date().toISOString(),
      })
      .select('*')
      .single()
    if (error || !data) throw new Error('could not record the event')
    return data as PipelineEvent
  }

  return {
    recordEvent,
    async advance(input) {
      const done = await replayed(input.userId, input.idempotencyKey)
      if (done) return done
      const { data } = await db.from('applications').select('state').eq('id', input.applicationId).eq('user_id', input.userId).maybeSingle()
      if (!data) throw new Error('not this person\'s application')
      const from = (data as { state: string | null }).state
      const event = await recordEvent({ userId: input.userId, applicationId: input.applicationId, kind: 'step.finished', actor: 'cello', channel: 'chat', sentence: input.sentence, idempotencyKey: input.idempotencyKey })
      await db.from('pipeline_events').update({ from_state: from, to_state: input.to }).eq('id', event.id)
      await db.from('applications').update({ state: input.to }).eq('id', input.applicationId).eq('user_id', input.userId)
      return { ...event, from_state: from as PipelineEvent['from_state'], to_state: input.to }
    },
    // ponytail: Needs you's rows come from its own sources; a test of Chat's status turns never reads them.
    async needsYou() {
      return { rows: [], count: 0 }
    },
  }
}
