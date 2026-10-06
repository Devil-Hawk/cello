// Reads one thing for one person: the body behind a chip, a card or a link, in the same shape for every kind.
// Every read is scoped to the person's id on the row, so another person's id gives null, never their data.

import { roleView } from '@/lib/agents/scoring-port'
import { getArtifact } from '@/lib/agents/artifacts'
import type { AdminClient } from '@/lib/harness/types'
import type { ChatObject, ObjectReader } from './types'

const first = <T>(rel: T | T[] | null | undefined): T | null => (Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null))
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const lines = (...l: (string | null | false | undefined)[]) => l.filter((x): x is string => Boolean(x))

type Row = Record<string, unknown>

async function own(db: AdminClient, table: string, columns: string, userId: string, id: string): Promise<Row | null> {
  const { data } = await db.from(table).select(columns).eq('id', id).eq('user_id', userId).maybeSingle()
  return (data as Row | null) ?? null
}

/** An earlier chat arrives as its date, what it held, what it made, and the person's typed lines. Never its answers. */
async function earlierChat(db: AdminClient, userId: string, chatId: string): Promise<ChatObject | null> {
  const chat = await own(db, 'chats', 'id, title, created_at', userId, chatId)
  if (!chat) return null
  const [turns, tiles] = await Promise.all([
    db.from('chat_turns').select('typed').eq('chat_id', chatId).eq('user_id', userId).eq('kind', 'person').is('superseded_at', null).order('created_at', { ascending: true }),
    db.from('chat_attachments').select('kind, ref').eq('chat_id', chatId).eq('user_id', userId).is('removed_at', null).order('position', { ascending: true }),
  ])
  const held = ((tiles.data as { kind: string; ref: Record<string, string> }[] | null) ?? []).map((t) => ({ kind: t.kind, id: t.ref.id ?? t.ref.chat_id ?? '' }))
  const madeIds = held.filter((t) => t.kind === 'made').map((t) => t.id)
  const made = madeIds.length ? (((await db.from('artifacts').select('id, type, title').eq('user_id', userId).in('id', madeIds.slice(0, 25))).data as Row[] | null) ?? []) : []
  return {
    kind: 'chat',
    id: chatId,
    title: String(chat.title || 'Untitled chat'),
    company: null,
    facts: lines(
      `Earlier chat from ${day(str(chat.created_at))}`,
      ...held.filter((t) => t.kind !== 'made').map((t) => `Held ${t.kind} ${t.id}`),
      ...made.map((m) => `Made ${m.type}: ${m.title} (${m.id})`)
    ),
    body: (((turns.data as { typed: string | null }[] | null) ?? []).map((t) => t.typed).filter(Boolean) as string[]).join('\n') || null,
  }
}

export const getObject: ObjectReader = async (db, userId, kind, ref) => {
  switch (kind) {
    case 'role': {
      const view = await roleView(db, userId, ref.id)
      if (!view) return null
      return {
        kind,
        id: ref.id,
        title: view.title ?? 'Untitled role',
        company: view.company,
        facts: lines(
          view.location && `Place: ${view.location}`,
          view.chance && `Chance: ${view.chance}`,
          view.salary && `Pay as stated: ${view.salary}`,
          view.postedAt && `Posted: ${day(view.postedAt)}`
        ),
        body: null,
      }
    }
    case 'company': {
      const row = await own(db, 'companies', 'id, name, domain', userId, ref.id)
      if (!row) return null
      return { kind, id: ref.id, title: String(row.name), company: String(row.name), facts: lines(str(row.domain) && `Site: ${str(row.domain)}`), body: null }
    }
    case 'application': {
      const row = await own(db, 'applications', 'id, stage, applied_at, jobs(title, companies(name))', userId, ref.id)
      if (!row) return null
      const job = first(row.jobs as { title?: string; companies?: { name?: string } | { name?: string }[] } | null)
      return {
        kind,
        id: ref.id,
        title: job?.title ?? 'Application',
        company: first(job?.companies)?.name ?? null,
        facts: lines(`Stage: ${row.stage}`, day(str(row.applied_at)) && `Applied: ${day(str(row.applied_at))}`),
        body: null,
      }
    }
    case 'person': {
      const row = await own(db, 'contacts', 'id, name, title', userId, ref.id)
      return row ? { kind, id: ref.id, title: String(row.name), company: null, facts: lines(str(row.title) && `Title: ${str(row.title)}`), body: null } : null
    }
    case 'chat':
      return earlierChat(db, userId, ref.chat_id)
    case 'made': {
      const made = await getArtifact(db, userId, ref.id)
      if (!made) return null
      return {
        kind,
        id: ref.id,
        title: made.artifact.title,
        company: null,
        facts: lines(`Kind: ${made.artifact.type}`, `Version: ${made.version.version}`),
        body: made.version.content_text,
      }
    }
    case 'material': {
      const row = await own(db, 'kb_documents', 'id, title', userId, ref.id)
      return row ? { kind, id: ref.id, title: String(row.title ?? 'Material'), company: null, facts: [], body: null } : null
    }
    // ponytail: a previewed role has no row until K5a; refused here, so it cannot be attached before it exists.
    case 'preview':
      return null
  }
}
