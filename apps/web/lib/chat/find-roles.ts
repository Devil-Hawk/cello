// roles.find: the roles a person holds that match a role type, a place and words, read from their own stored roles.
// Code only. The type comes from the taxonomy (a label, an id or an abbreviation such as FDE), the place from a short
// map of what people call the same place, and every field returned is read from the row. The sentence says what was
// searched and how many matched, so the answer never has to say it for code.

import { personJobs } from '@/lib/jobs/person-jobs'
import { getRoleType, ROLE_TYPES, typeTitle } from '@/lib/jobs/role-types'
import { listRoleTypes } from '@/lib/jobs/role-types/list'
import type { AdminClient } from '@/lib/harness/types'
import { resolveTargeting } from '@/lib/targeting'
import type { Thing } from './things'

export const MAX_FOUND = 12

/** What people call one place. A place not named here is matched as the words typed. */
const PLACES: { says: RegExp; label: string; test: RegExp }[] = [
  { says: /^(sf|san francisco|san francisco bay area|sf bay area|the bay|bay area)$/i, label: 'San Francisco', test: /\b(san francisco|sf|bay area)\b/i },
  { says: /^(nyc|new york|new york city|ny)$/i, label: 'New York', test: /\b(new york|nyc|ny)\b/i },
  { says: /^(la|los angeles)$/i, label: 'Los Angeles', test: /\b(los angeles|la)\b/i },
  { says: /^(remote|anywhere)$/i, label: 'Remote', test: /\bremote\b/i },
]

export function placeMatcher(place: string): { label: string; test: (location: string | null) => boolean } {
  const words = place.replace(/\s+/g, ' ').trim()
  const known = PLACES.find((p) => p.says.test(words))
  if (known) return { label: known.label, test: (l) => known.test.test(l ?? '') }
  const needle = words.toLowerCase()
  return { label: words, test: (l) => (l ?? '').toLowerCase().includes(needle) }
}

/** A role type from what a person or a model wrote: the abbreviation, the label or the id. Null when none fits. */
export function resolveRoleType(text: string): { id: string; label: string } | null {
  const typed = typeTitle(text).role_type
  const byId = getRoleType(text.trim().toLowerCase().replace(/\s+/g, '-'))
  const byLabel = ROLE_TYPES.find((t) => t.label.toLowerCase() === text.trim().toLowerCase())
  const id = typed ?? byId?.id ?? byLabel?.id ?? listRoleTypes(text, { limit: 1 })[0]?.id ?? null
  const def = id ? getRoleType(id) : undefined
  return def && def.id !== 'other' ? { id: def.id, label: def.label } : null
}

export interface FindRolesInput {
  type?: string
  place?: string
  words?: string
  /** Only the roles the person marked Interested. */
  interested?: boolean
  limit: number
  /** newest posting first (a search), or the Roles page's own ranking: the stored want, then the newest (a "top three"). */
  order?: 'newest' | 'ranked'
}

interface Row {
  id: string
  title: string
  location: string | null
  salary_range: string | null
  posted_at: string | null
  role_type: string | null
  viewer_role_type: string | null
  viewer_company_name: string | null
  employer_id: string | null
}

/** 'A', 'A and B', 'A, B and C'; past `show` items the rest become 'and <n> more'. */
function joined(items: string[], word: 'and' | 'or', show: number): string {
  const list = items.length > show ? [...items.slice(0, show), `${items.length - show} more`] : items
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} ${word} ${list[list.length - 1]}`
}

/** What the person saved on Your search: role type labels (unknown and 'other' dropped) and place matchers, both deduped. */
async function savedTargets(db: AdminClient, userId: string) {
  const { data, error } = await db.from('profiles').select('preferences').eq('id', userId).maybeSingle()
  if (error) throw new Error(`Cello could not read your saved search: ${error.message}`)
  const preferences = (data as { preferences?: Record<string, unknown> | null } | null)?.preferences ?? {}
  const types = new Map<string, string>()
  for (const id of resolveTargeting(preferences).role_types ?? []) {
    const def = getRoleType(id)
    if (def && def.id !== 'other') types.set(def.id, def.label)
  }
  const places = new Map<string, ReturnType<typeof placeMatcher>>()
  const saved = preferences.preferredLocations
  for (const p of Array.isArray(saved) ? saved : []) {
    if (typeof p !== 'string' || !p.trim()) continue
    const m = placeMatcher(p)
    if (!places.has(m.label)) places.set(m.label, { label: m.label.slice(0, 40), test: m.test })
  }
  return { types, places: [...places.values()] }
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
const WORDS = /[\p{L}\p{N}+#.]{2,}/gu

export async function findRoles(db: AdminClient, userId: string, input: FindRolesInput): Promise<{ things: Thing[]; sentence: string; matched: number }> {
  const type = input.type ? resolveRoleType(input.type) : null
  const place = input.place ? placeMatcher(input.place) : null
  const terms = [...new Set((input.words ?? '').toLowerCase().match(WORDS) ?? [])].slice(0, 6)
  const limit = Math.min(Math.max(input.limit, 1), MAX_FOUND)
  // Nothing typed: the person's saved roles and places on Your search stand in for it.
  const saved = !input.type && !input.place && !input.words ? await savedTargets(db, userId) : null
  const targets = saved && (saved.types.size > 0 || saved.places.length > 0) ? saved : null

  let q = personJobs(db)
    .select('id, title, location, salary_range, posted_at, role_type, viewer_role_type, viewer_company_name, employer_id')
    .eq('viewer_id', userId)
    .is('hidden_reason', null)
    .neq('still_open', false)
  if (type) q = q.or(`viewer_role_type.eq.${type.id},role_type.eq.${type.id}`)
  if (input.interested) q = q.not('saved_at', 'is', null)
  const [{ data, error }, total] = await Promise.all([
    q.order('posted_at', { ascending: false, nullsFirst: false }).limit(1000),
    personJobs(db).select('id', { count: 'exact', head: true }).eq('viewer_id', userId).is('hidden_reason', null),
  ])
  // A read that failed is not an empty list: say so instead of "0 match".
  if (error) throw new Error(`Cello could not read your stored roles: ${error.message}`)

  let rows = ((data as Row[] | null) ?? []).filter(
    (r) =>
      (!type || (r.viewer_role_type ?? r.role_type) === type.id) &&
      (!place || place.test(r.location)) &&
      (!targets?.types.size || targets.types.has((r.viewer_role_type ?? r.role_type) ?? '')) &&
      (!targets?.places.length || targets.places.some((p) => p.test(r.location))) &&
      terms.every((t) => `${r.title} ${r.viewer_company_name ?? ''}`.toLowerCase().includes(t))
  )

  // Saved targets only: leave out what the person already applied to (a skipped or unsent one is open again, and a role only saved with Interested has no state and stage discovered) or turned down.
  let leftOut = 0
  if (targets) {
    const matchedIds = rows.map((r) => r.id).slice(0, 300)
    const [apps, reactions] = matchedIds.length
      ? await Promise.all([
          db.from('applications').select('job_id, state, stage').eq('user_id', userId).in('job_id', matchedIds),
          db.from('role_reactions').select('job_id').eq('user_id', userId).eq('reaction', 'not_for_me').in('job_id', matchedIds),
        ])
      : [null, null]
    if (apps?.error || reactions?.error) throw new Error(`Cello could not read your applications: ${(apps?.error ?? reactions?.error)?.message}`)
    const out = new Set<string>()
    for (const a of (apps?.data as { job_id: string; state: string | null; stage: string | null }[] | null) ?? []) if (a.state ? a.state !== 'skipped' && a.state !== 'not_sent' : a.stage !== 'discovered') out.add(a.job_id)
    for (const x of (reactions?.data as { job_id: string }[] | null) ?? []) out.add(x.job_id)
    leftOut = rows.filter((r) => out.has(r.id)).length
    rows = rows.filter((r) => !out.has(r.id))
  }

  // The stored chance, and an employer's name for a role the person holds under no company of their own.
  const ids = rows.map((r) => r.id).slice(0, 300)
  const employerIds = [...new Set(rows.filter((r) => !r.viewer_company_name && r.employer_id).map((r) => r.employer_id as string))].slice(0, 100)
  const [chances, employers] = await Promise.all([
    ids.length ? db.from('person_roles').select('job_id, chance, want_p').eq('user_id', userId).in('job_id', ids.slice(0, 300)) : null,
    employerIds.length ? db.from('company_directory').select('id, name').in('id', employerIds.slice(0, 100)) : null,
  ])
  const stored = (chances?.data as { job_id: string; chance: string | null; want_p: number | null }[] | null) ?? []
  const chanceOf = new Map(stored.map((c) => [c.job_id, c.chance]))
  const wantOf = new Map(stored.map((c) => [c.job_id, c.want_p ?? -1]))
  const employerName = new Map(((employers?.data as { id: string; name: string }[] | null) ?? []).map((e) => [e.id, e.name]))
  const chanceFor = (id: string): Thing['chance'] => {
    const c = chanceOf.get(id)
    return c === 'strong' || c === 'possible' || c === 'stretch' ? c : null
  }
  const newest = (a: Row, b: Row) => (b.posted_at ?? '').localeCompare(a.posted_at ?? '')
  // ponytail: ranked reads only the first 300 matches' want, which is the page the Roles list shows first as well.
  const ranked = [...rows].sort(input.order === 'ranked' ? (a, b) => (wantOf.get(b.id) ?? -1) - (wantOf.get(a.id) ?? -1) || newest(a, b) : newest)
  const things: Thing[] = ranked.slice(0, limit).map((r) => ({
    kind: 'role',
    id: r.id,
    title: r.title,
    company: r.viewer_company_name ?? (r.employer_id ? (employerName.get(r.employer_id) ?? null) : null),
    place: r.location,
    pay: r.salary_range,
    chance: chanceFor(r.id),
    posted: day(r.posted_at),
    notes: [],
  }))

  const what = [type?.label ?? (input.type ? `"${input.type}"` : null), place ? `in ${place.label}` : null, terms.length ? `with ${terms.join(' ')}` : null, input.interested ? 'you marked Interested' : null].filter(Boolean).join(' ')
  const matched = rows.length
  const count = matched === 0 ? 'none match' : matched <= limit ? `${matched} match` : `${matched} match, ${limit} shown`
  const roles = total.count == null ? 'your stored roles' : `your ${total.count} stored roles`
  if (targets) {
    const types = [...targets.types.values()]
    const places = targets.places.map((p) => p.label)
    const sentence =
      `Searched ${roles}` +
      (types.length ? ` for your targets, ${joined(types, 'and', 4)}` : '') +
      (places.length ? `${types.length ? ',' : ''} in ${joined(places, 'or', 3)}` : '') +
      (input.interested ? ', only those you marked Interested' : '') +
      (leftOut ? `, leaving out ${leftOut} you already applied to or turned down` : '') +
      `: ${count}.`
    return { things, sentence, matched }
  }
  const sentence = `Searched ${roles}${what ? ` for ${what}` : ''}: ${count}.${saved ? ' Set the roles and places you want on Your search, and Cello uses them here.' : ''}`
  return { things, sentence, matched }
}
