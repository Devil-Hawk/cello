// roles.match: every 30 minutes, in slices, the judging of kept roles (lib/roles/judge.ts).
//
// People with a waiting role (never judged, a changed posting cleared it, or a changed resume marked it: the database clears
// judged_at) are taken one after another: people who asked with "Check chances for all" first, then those who have used the
// least of today's free calls. Each person's waiting roles go newest first, followed employers before the directory, three to
// a model call. A person stops at their day share, the whole run at the minute bucket's patience or when no model exists, and a
// slice that ran out of time hands on to the next one at once. Nothing here names a model: the free door does.
//
// The heartbeat's found is { judged, waiting, people }, plus `stopped: 'no_model'` when nothing could be asked at all.

import { judgeRoles, nextWaiting, type JudgeDeps } from '../../roles/judge'
import type { RoutineContext, RoutineOutcome } from '../routines'

const PER_CALL = 3
const PEOPLE_WINDOW = 2000
/** The bucket refills a call every three seconds. */
const MINUTE_WAIT_MS = 3_000
const MINUTE_PATIENCE = 5

export interface MatchDeps {
  judge: typeof judgeRoles
  waiting: typeof nextWaiting
  sleep: (ms: number) => Promise<void>
  judgeDeps?: JudgeDeps
}

export const realMatchDeps: MatchDeps = { judge: judgeRoles, waiting: nextWaiting, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function matchWith(ctx: RoutineContext, deps: MatchDeps): Promise<RoutineOutcome> {
  const db = ctx.admin
  const day = new Date(ctx.now()).toISOString().slice(0, 10)
  const first = ctx.state === null
  const args = (ctx.routine.args ?? {}) as Record<string, unknown>
  const front = first ? strings(args.front) : strings(ctx.state?.front)
  const done = new Set(strings(ctx.state?.done))
  let judged = Number(ctx.state?.judged ?? 0)
  if (first && front.length > 0) {
    // ponytail: read-modify-write of the routine's args; a click in the same instant can be lost (the person's roles still wait their turn).
    await db.from('routines').update({ args: { ...args, front: [] } }).eq('id', ctx.routine.id)
  }

  const { data: rows, error } = await db.from('person_roles').select('user_id').is('judged_at', null).is('hidden_reason', null).limit(PEOPLE_WINDOW)
  if (error) return { ok: false, failure: 'waiting_failed' }
  const waitingPeople = [...new Set(((rows as { user_id: string }[] | null) ?? []).map((r) => r.user_id))]
  const { data: budget } = await db.from('judge_budget').select('by_user').eq('day', day).maybeSingle()
  const used = (id: string) => Number((budget as { by_user?: Record<string, number> } | null)?.by_user?.[id] ?? 0)
  const people = [...waitingPeople.filter((id) => front.includes(id)), ...waitingPeople.filter((id) => !front.includes(id)).sort((a, b) => used(a) - used(b))].filter((id) => !done.has(id))

  let stopped: string | null = null
  let patience = 0
  for (const person of people) {
    let finished = false
    // Roles tried in this slice are not asked for again in it: a check that came back unusable is retried by a later slice.
    const tried = new Set<string>()
    while (ctx.now() < ctx.deadlineAt && !stopped) {
      const ids = (await deps.waiting(db, person, PER_CALL + tried.size)).filter((id) => !tried.has(id)).slice(0, PER_CALL)
      if (ids.length === 0) {
        finished = true
        break
      }
      for (const id of ids) tried.add(id)
      const out = await deps.judge(db, person, ids, deps.judgeDeps)
      judged += out.judged.length
      if (out.stopped === 'no_model') stopped = 'no_model'
      else if (out.stopped === 'minute') {
        for (const id of ids) tried.delete(id)
        if (++patience > MINUTE_PATIENCE) stopped = 'minute'
        else await deps.sleep(MINUTE_WAIT_MS)
        continue
      } else patience = 0
      // The person's day share is used, they have no resume, or nothing was judged: on to the next person.
      if (out.stopped === 'day' || out.stopped === 'no_resume' || out.judged.length === 0) {
        finished = true
        break
      }
    }
    if (finished) done.add(person)
    if (stopped || ctx.now() >= ctx.deadlineAt) break
  }

  // Out of time with people still to do: the next slice carries on at once. A run stopped by a limit waits for its next due time.
  if (!stopped && people.some((id) => !done.has(id))) return { ok: true, next: { done: [...done], judged, front } }
  const { count } = await db.from('person_roles').select('job_id', { count: 'exact', head: true }).is('judged_at', null).is('hidden_reason', null)
  return { ok: true, found: { judged, waiting: count ?? 0, people: waitingPeople.length, ...(stopped === 'no_model' ? { stopped } : {}) } }
}

export const rolesMatch = (ctx: RoutineContext): Promise<RoutineOutcome> => matchWith(ctx, realMatchDeps)
