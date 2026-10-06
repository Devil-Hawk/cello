// lane-stub: K10 runCommand
// The finder behind [Add] and "@": the person's own roles, companies, applications, people, earlier chats and made things whose name
// holds the words typed. Words only, read under the person's id on every row; it becomes a search command's call when
// the registry is on main. A match is only a name to pick: attaching it still goes through attach.ts and the thing's own get.

import type { AdminClient } from '@/lib/harness/types'
import type { AttachKind } from './types'

export interface Found {
  kind: Extract<AttachKind, 'role' | 'company' | 'application' | 'person' | 'chat' | 'made'>
  id: string
  name: string
  /** The company for a role or an application; the title for a person. */
  detail: string | null
}

const PER_KIND = 5
const first = <T>(rel: T | T[] | null | undefined): T | null => (Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null))

type JobRel = { title?: string; companies?: { name?: string } | { name?: string }[] | null } | { title?: string; companies?: { name?: string } | { name?: string }[] | null }[] | null
const job = (rel: JobRel) => {
  const j = first(rel)
  return { name: j?.title ?? 'Untitled role', detail: first(j?.companies)?.name ?? null }
}

export async function findThings(db: AdminClient, userId: string, words: string): Promise<Found[]> {
  // % and _ are the pattern's own marks: a person typing them means the characters, which a name seldom holds.
  const clean = words.replace(/[%_\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (clean.length < 1) return []
  const like = `%${clean}%`
  const [roles, companies, applications, people, chats, made] = await Promise.all([
    db.from('person_roles').select('job_id, jobs!inner(title, companies(name))').eq('user_id', userId).ilike('jobs.title', like).limit(PER_KIND),
    db.from('companies').select('id, name').eq('user_id', userId).ilike('name', like).limit(PER_KIND),
    db.from('applications').select('id, jobs!inner(title, companies(name))').eq('user_id', userId).ilike('jobs.title', like).limit(PER_KIND),
    db.from('contacts').select('id, name, title').eq('user_id', userId).ilike('name', like).limit(PER_KIND),
    db.from('chats').select('id, title').eq('user_id', userId).ilike('title', like).limit(PER_KIND),
    db.from('artifacts').select('id, title, type').eq('user_id', userId).ilike('title', like).limit(PER_KIND),
  ])
  const rows = <T>(r: { data: unknown }) => ((r.data as T[] | null) ?? [])
  return [
    ...rows<{ job_id: string; jobs: JobRel }>(roles).map((r): Found => ({ kind: 'role', id: r.job_id, ...job(r.jobs) })),
    ...rows<{ id: string; name: string }>(companies).map((r): Found => ({ kind: 'company', id: r.id, name: r.name, detail: null })),
    ...rows<{ id: string; jobs: JobRel }>(applications).map((r): Found => ({ kind: 'application', id: r.id, ...job(r.jobs) })),
    ...rows<{ id: string; name: string; title: string | null }>(people).map((r): Found => ({ kind: 'person', id: r.id, name: r.name, detail: r.title })),
    ...rows<{ id: string; title: string }>(chats).map((r): Found => ({ kind: 'chat', id: r.id, name: r.title.trim() || 'New chat', detail: null })),
    ...rows<{ id: string; title: string; type: string }>(made).map((r): Found => ({ kind: 'made', id: r.id, name: r.title, detail: r.type.replace(/_/g, ' ') })),
  ]
}
