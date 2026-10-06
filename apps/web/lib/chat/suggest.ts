// chat.suggest: the greeting and the three suggestions under the compose box of an empty chat (blueprint 4.13).
// Code from the person's own records, no model. Candidates are ranked in a fixed order; the first three that hold
// are shown, one per kind and never two about one object. A tap puts the text in the compose box and its things
// as tiles; nothing is sent until Send.
//
// The kinds below are the ones this lane can read today. Replies waiting, Needs you, follow-ups and new roles at
// followed employers belong to the lanes that own that data: they add candidates in lib/chat/extend/<lane>.ts.

import type { AdminClient } from '@/lib/harness/types'
import { suggestCandidates as extra, type SuggestCandidate } from './extend'

const SHOW = 3
const MAX_TEXT = 40
const DAY = 86_400_000

/** Priorities in 4.13's order. Lanes that add candidates use the same scale. */
export const PRIORITY = { reply: 100, needsYou: 90, apply: 80, compare: 70, followUp: 60, whatsNew: 50, find: 30, tailor: 20, working: 10 } as const

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text)

export function greeting(name: string | null | undefined, now: Date, timeZone: string): string {
  const first = name?.trim().split(/\s+/)[0]
  if (!first) return 'What are we working on?'
  let hour: number
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now))
  } catch {
    hour = now.getUTCHours()
  }
  return `${hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'}, ${first}.`
}

interface Interested {
  job_id: string | null
  job_title: string
  company_name: string | null
  created_at: string
}

/** Candidates from what this lane can read: Interested roles with no application, and counts. */
async function core(db: AdminClient, userId: string, now: Date): Promise<SuggestCandidate[]> {
  const since = new Date(now.getTime() - 7 * DAY).toISOString()
  const [reacted, applied] = await Promise.all([
    db.from('role_reactions').select('job_id, job_title, company_name, created_at').eq('user_id', userId).eq('reaction', 'interested').gte('created_at', since).order('created_at', { ascending: false }).limit(50),
    db.from('applications').select('job_id').eq('user_id', userId),
  ])
  const started = new Set(((applied.data as { job_id: string }[] | null) ?? []).map((a) => a.job_id))
  const seen = new Set<string>()
  const interested: (Interested & { job_id: string })[] = []
  for (const r of (reacted.data as Interested[] | null) ?? []) {
    if (r.job_id && !seen.has(r.job_id)) {
      seen.add(r.job_id)
      interested.push({ ...r, job_id: r.job_id })
    }
  }
  const open = interested.find((r) => !started.has(r.job_id))
  const out: SuggestCandidate[] = []
  if (open) {
    out.push({ kind: 'apply', text: cut(`Apply to the ${open.company_name ?? open.job_title} role`), priority: PRIORITY.apply, objects: [{ kind: 'role', ref: open.job_id }] })
  }
  if (interested.length >= 3) {
    const n = Math.min(interested.length, 12)
    out.push({ kind: 'compare', text: cut(`Compare my ${n}`), priority: PRIORITY.compare, objects: interested.slice(0, n).map((r) => ({ kind: 'role', ref: r.job_id })) })
  }
  out.push({ kind: 'find', text: 'Find new roles', priority: PRIORITY.find }, { kind: 'tailor', text: 'Tailor my resume for a role', priority: PRIORITY.tailor })
  if (started.size >= 5) out.push({ kind: 'working', text: 'What is working in my search?', priority: PRIORITY.working })
  return out
}

export interface Suggestions {
  greeting: string
  suggestions: { text: string; objects: { kind: string; ref: string }[] }[]
}

export async function suggest(db: AdminClient, userId: string, opts: { name?: string | null; timeZone?: string; now?: Date } = {}): Promise<Suggestions> {
  const now = opts.now ?? new Date()
  const ranked = [...(await core(db, userId, now)), ...extra].sort((a, b) => b.priority - a.priority)
  const kinds = new Set<string>()
  const used = new Set<string>()
  const picked: Suggestions['suggestions'] = []
  for (const c of ranked) {
    const objects = c.objects ?? []
    // One per kind, and never two about one object.
    if (kinds.has(c.kind) || (objects.length === 1 && used.has(`${objects[0].kind}:${objects[0].ref}`))) continue
    kinds.add(c.kind)
    for (const o of objects) used.add(`${o.kind}:${o.ref}`)
    picked.push({ text: cut(c.text), objects })
    if (picked.length === SHOW) break
  }
  return { greeting: greeting(opts.name, now, opts.timeZone ?? 'UTC'), suggestions: picked }
}
