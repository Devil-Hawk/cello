// Tiles: what a chat holds. Bodies of chat.attach and chat.detach once the registry is on main.
//
// The rules, each of them in code and not in a prompt:
//   - a ref is checked strictly (extra keys or a malformed id are refused) and then read through the thing's
//     own get command under the person's rights, so another person's role, chat or made thing is refused;
//   - Cello may attach only a thing a tool returned in this turn, and at most 12 a turn;
//   - at most 25 are held at once (the database counts it under a lock; the count here only words the refusal);
//   - detaching keeps the row, so an older answer still shows the tile it was about.

import { z } from 'zod'
import type { AdminClient } from '@/lib/harness/types'
import { getObject } from './ports/commands.stub'
import { ATTACH_KINDS, MAX_TILES, refId, type AttachKind, type AttachmentRow, type ObjectReader, type Refusal, type StoredRef } from './types'

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

const REF_SHAPES: Record<AttachKind, z.ZodType<StoredRef>> = {
  role: z.strictObject({ id }),
  company: z.strictObject({ id }),
  application: z.strictObject({ id }),
  person: z.strictObject({ id }),
  material: z.strictObject({ id }),
  chat: z.strictObject({ chat_id: id }),
  made: z.strictObject({ table: z.literal('artifacts'), id }),
  preview: z.strictObject({ employer_id: id, posting_key: z.string().min(1).max(200) }),
}

export const CELLO_ATTACHES_PER_TURN = 12

/** The key a turn's ledger uses for a thing a tool returned. */
export const ledgerKey = (kind: AttachKind, ref: StoredRef | string) => `${kind}:${typeof ref === 'string' ? ref : refId(kind, ref)}`

export type AttachBy =
  | { origin: 'person'; door: string }
  /** `returned` holds the ledgerKey of every thing a tool returned in this turn. */
  | { origin: 'model'; turnId: string; returned: ReadonlySet<string> }

export type AttachResult = { ok: true; attachment: AttachmentRow; already: boolean } | Refusal

const COLUMNS = 'id, user_id, chat_id, position, kind, ref, origin, prov, added_at, removed_at'
const refuse = (error: string, fix: string): Refusal => ({ ok: false, error, fix })
const FULL = refuse(`This chat already holds ${MAX_TILES} things.`, 'Remove one to add another.')

export async function attach(
  db: AdminClient,
  userId: string,
  chatId: string,
  input: { kind: string; ref: unknown },
  by: AttachBy,
  get: ObjectReader = getObject
): Promise<AttachResult> {
  const kind = ATTACH_KINDS.find((k) => k === input.kind)
  const ref = kind ? REF_SHAPES[kind].safeParse(input.ref) : null
  if (!kind || !ref?.success) return refuse('That is not something a chat can hold.', 'Pick it from your roles, companies, applications, people, chats or made things.')

  const { data: chat } = await db.from('chats').select('id').eq('id', chatId).eq('user_id', userId).maybeSingle()
  if (!chat) return refuse('That chat was not found.', 'Open it from your chats.')

  if (by.origin === 'model') {
    if (!by.returned.has(ledgerKey(kind, ref.data))) {
      return refuse('Cello can only add what a tool returned in this turn.', 'Add it yourself from the chat.')
    }
    const { data: byCello } = await db.from('chat_attachments').select('prov').eq('chat_id', chatId).eq('user_id', userId).eq('origin', 'model')
    const turnId = by.turnId
    const thisTurn = ((byCello as { prov: { turn_id?: string } | null }[] | null) ?? []).filter((r) => r.prov?.turn_id === turnId).length
    if (thisTurn >= CELLO_ATTACHES_PER_TURN) return refuse(`Cello adds at most ${CELLO_ATTACHES_PER_TURN} things a turn.`, 'Add the rest yourself.')
  }

  // Through the thing's own get command, under the person's rights: not theirs reads as not found.
  if (!(await get(db, userId, kind, ref.data))) return refuse('That is not in your account.', 'Pick it from your own records.')

  const held = (await db.from('chat_attachments').select(COLUMNS).eq('chat_id', chatId).eq('user_id', userId).is('removed_at', null)).data as AttachmentRow[] | null
  const same = (held ?? []).find((r) => r.kind === kind && refId(kind, r.ref) === refId(kind, ref.data))
  if (same) return { ok: true, attachment: same, already: true }
  if ((held ?? []).length >= MAX_TILES) return FULL

  const { data, error } = await db
    .from('chat_attachments')
    .insert({
      user_id: userId,
      chat_id: chatId,
      kind,
      ref: ref.data,
      origin: by.origin,
      prov: by.origin === 'person' ? { door: by.door } : { turn_id: by.turnId },
    })
    .select(COLUMNS)
    .single()
  // 23514 is the database's own 25 limit, reached by two attaches racing each other.
  if (error?.code === '23514') return FULL
  if (error || !data) return refuse('Could not add that to the chat.', 'Try again.')
  return { ok: true, attachment: data as AttachmentRow, already: false }
}

/** Detaching sets removed_at and keeps the row. */
export async function detach(db: AdminClient, userId: string, chatId: string, attachmentId: string): Promise<{ ok: true } | Refusal> {
  const { data } = await db
    .from('chat_attachments')
    .update({ removed_at: new Date().toISOString() })
    .eq('id', attachmentId)
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .is('removed_at', null)
    .select('id')
  return ((data as unknown[] | null) ?? []).length === 1 ? { ok: true } : refuse('That is not attached to this chat.', 'Reload the chat.')
}

/** The tiles a chat holds now, in the order they were attached. */
export async function activeTiles(db: AdminClient, userId: string, chatId: string): Promise<AttachmentRow[]> {
  const { data } = await db
    .from('chat_attachments')
    .select(COLUMNS)
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .is('removed_at', null)
    .order('position', { ascending: true })
  return (data as AttachmentRow[] | null) ?? []
}
