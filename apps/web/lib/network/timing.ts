// Follow-up timing, counted by code (blueprint 9, directive 39): of the follow-ups the person sent, how many
// were answered, by how many business days they waited and the kind of person. A group with 10 or more
// follow-ups on both sides that answers clearly more often becomes a proposal to change the global rule
// (effect nudge.rule), which acts only on Keep. A model writes none of it.

import { differenceInBusinessDays } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CountInput } from '@/lib/learning/store'

export const MIN_FOLLOW_UPS = 10
/** How much higher the better group's reply rate must be before Cello says so. */
export const MIN_GAP = 0.2

/** The waits a rule can be set to: up to 3 business days, 4 to 5, 6 or more. */
const BUCKETS = [3, 5, 8] as const
const bucketOf = (waited: number) => BUCKETS.find((b, i) => waited <= b || i === BUCKETS.length - 1) as number

export interface MessageRow {
  contact_id: string
  thread_id: string
  direction: 'in' | 'out'
  sent_at: string
  contacts?: { kind: string | null } | null
}

export interface TimingGroup {
  who: 'Recruiters' | 'Contacts'
  /** Business days waited, as the bucket's top value. */
  waited: number
  sent: number
  answered: number
}

/** A follow-up is a message of yours sent after your own message with no reply between. It was answered when the next message is theirs. */
export function followUpGroups(rows: MessageRow[]): TimingGroup[] {
  const threads = new Map<string, MessageRow[]>()
  for (const r of rows) threads.set(`${r.contact_id}:${r.thread_id}`, [...(threads.get(`${r.contact_id}:${r.thread_id}`) ?? []), r])
  const groups = new Map<string, TimingGroup>()
  for (const ms of threads.values()) {
    ms.sort((a, b) => a.sent_at.localeCompare(b.sent_at))
    const kind = ms[0].contacts?.kind
    const who = kind === 'recruiter' || kind === 'agency_recruiter' ? 'Recruiters' : 'Contacts'
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].direction !== 'out' || ms[i - 1].direction !== 'out') continue
      const waited = bucketOf(Math.max(1, differenceInBusinessDays(new Date(ms[i].sent_at), new Date(ms[i - 1].sent_at))))
      const g = groups.get(`${who}:${waited}`) ?? { who, waited, sent: 0, answered: 0 }
      g.sent += 1
      if (ms[i + 1]?.direction === 'in') g.answered += 1
      groups.set(`${who}:${waited}`, g)
    }
  }
  return [...groups.values()]
}

/** One proposal per kind of person whose best-answered wait leads the next by MIN_GAP, over groups of MIN_FOLLOW_UPS or more. */
export function timingCounts(groups: TimingGroup[]): CountInput[] {
  const out: CountInput[] = []
  for (const who of ['Recruiters', 'Contacts'] as const) {
    const big = groups.filter((g) => g.who === who && g.sent >= MIN_FOLLOW_UPS).sort((a, b) => b.answered / b.sent - a.answered / a.sent)
    const [best, next] = big
    if (!best || !next || best.answered / best.sent - next.answered / next.sent < MIN_GAP) continue
    out.push({
      key: `timing:follow-up:${who.toLowerCase()}`,
      kind: 'timing',
      effect: 'nudge.rule',
      params: { after_yours_bd: best.waited },
      statement: `${who} answered follow-ups sent after ${best.waited} business days more often: ${best.answered} of ${best.sent}, against ${next.answered} of ${next.sent} after ${next.waited} business days.`,
      n: best.sent + next.sent,
      status: 'proposed',
    })
  }
  return out
}

/** Reads the person's mail rows and writes or recounts the proposals. A kept proposal stays kept and an off one stays off. */
export async function proposeTiming(admin: SupabaseClient, userId: string): Promise<number> {
  const { data } = await admin
    .from('messages')
    .select('contact_id, thread_id, direction, sent_at, contacts(kind)')
    .eq('user_id', userId)
    .not('contact_id', 'is', null)
    .not('thread_id', 'is', null)
    .limit(20_000)
  const counts = timingCounts(followUpGroups((data ?? []) as unknown as MessageRow[]))
  if (!counts.length) return 0
  const { upsertCount } = await import('@/lib/learning/store')
  for (const c of counts) await upsertCount(userId, c)
  return counts.length
}
