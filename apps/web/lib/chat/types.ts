// Shared shapes of Chat: what can be attached, what an answer part looks like, what a stored turn holds.
// One file, no behaviour except the two small helpers every other file in lib/chat needs.

import type { AdminClient } from '@/lib/harness/types'

/** Things a chat can hold as tiles (blueprint 3.3). A file the person attaches goes to Your material first. */
export const ATTACH_KINDS = ['role', 'preview', 'company', 'application', 'person', 'chat', 'made', 'material'] as const
export type AttachKind = (typeof ATTACH_KINDS)[number]

/** A chat holds at most this many things at once. The database enforces it; this is for the words around it. */
export const MAX_TILES = 25

/** Which table a kind's id points at, for the links a turn stores. A preview has no row of its own. */
export const TABLE_OF: Record<AttachKind, string | null> = {
  role: 'jobs',
  preview: null,
  company: 'companies',
  application: 'applications',
  person: 'contacts',
  chat: 'chats',
  made: 'artifacts',
  material: 'kb_documents',
}

/** The stored `ref` of an attachment: strings only, shaped by the kind (see attach.ts). */
export type StoredRef = Record<string, string>

/**
 * The one string that names an attached thing everywhere a person's or a model's eyes meet it:
 * a part's `about`, the turn's subject, a `cello:` link, a tile. The id for most kinds.
 */
export function refId(kind: AttachKind, ref: StoredRef): string {
  if (kind === 'chat') return ref.chat_id ?? ''
  if (kind === 'preview') return `${ref.employer_id}:${ref.posting_key}`
  return ref.id ?? ''
}

/** An attached thing as code reads it through its own get command, under the person's rights. */
export interface ChatObject {
  kind: AttachKind
  /** `refId` of the thing. */
  id: string
  title: string
  company: string | null
  /** Code facts, one per line: ids, enums, dates. Never model text. */
  facts: string[]
  /**
   * Text someone else wrote (a made thing's start, an earlier chat's typed lines). It reaches the model
   * quoted as Cello's earlier read, never as an instruction.
   */
  body: string | null
}

/** What the page and a chip call a thing: a role or an application is named with its employer, so two roles with one title differ. */
export const objectName = (o: Pick<ChatObject, 'kind' | 'title' | 'company'>) => ((o.kind === 'role' || o.kind === 'application') && o.company ? `${o.title} at ${o.company}` : o.title)

/** Reads one thing for one person. Null for anything that is not theirs or no longer exists. */
export type ObjectReader = (db: AdminClient, userId: string, kind: AttachKind, ref: StoredRef) => Promise<ChatObject | null>

export interface ObjectRef {
  kind: AttachKind
  ref: string
}

/** A part of an answer: Markdown text about zero or more objects, or a card whose fields code reads from the row. */
export type Part = { about: ObjectRef[]; text: string } | { card: ObjectRef }

export interface TurnLink {
  kind: AttachKind
  table: string | null
  id: string
  role: 'named' | 'made' | 'recalled'
  /** A recalled link also names where it came from. */
  source?: { chat_id: string; turn_id: string }
}

export interface ChatRow {
  id: string
  user_id: string
  title: string
  created_at: string
  last_turn_at: string
  archived_at: string | null
  project_id: string | null
  pinned_at: string | null
  model_choice: unknown
  settings: Record<string, unknown>
}

export interface TurnRow {
  id: string
  user_id: string
  chat_id: string
  kind: 'person' | 'cello' | 'status'
  typed: string | null
  answer: string | null
  origin: 'person' | 'code' | 'model'
  parts: Part[]
  links: TurnLink[]
  quoted: { text: string; turn_id: string } | null
  /** A status turn names the pipeline event it reports; the sentence is read from that event (status.ts). */
  event_id: string | null
  /** Written by code at the turn's end (lib/chat/disclosure.ts). */
  disclosure: unknown
  superseded_at: string | null
  /** Set on a turn that replaced an earlier one of the person's (chat.edit_turn); the old branch stays. */
  branch_of: string | null
  created_at: string
}

export interface AttachmentRow {
  id: string
  user_id: string
  chat_id: string
  position: number
  kind: AttachKind
  ref: StoredRef
  origin: 'person' | 'model'
  prov: Record<string, unknown> | null
  added_at: string
  removed_at: string | null
}

/** Code's own words for a refusal: what happened and what the person can do. */
export type Refusal = { ok: false; error: string; fix: string }
