// One-time backfill of chat memories for every chat that exists when recall ships (K24c, post-deploy).
//
//   pnpm tsx lib/chat/memory-backfill.ts            all people
//   pnpm tsx lib/chat/memory-backfill.ts <user id>  one person
//
// For each person turn it writes the chat.said memory, and for each thing a turn made, the chat.made memory.
// It checks itself by count: the memories the people should have against the memories they have afterwards,
// and exits 1 when they differ. A second run writes nothing that already exists.
// Decisions (chat.decided) are not backfilled: they are written from events as they happen.

import type { AdminClient } from '@/lib/harness/types'
import { writeTurnMemories, type ChatMemoryStore } from './memory'

export interface BackfillResult {
  /** Memories the person's chats call for (a said per person turn, a made per made thing). */
  expected: number
  /** Memories they hold afterwards, counted in the store itself. */
  held: number
  written: number
  failed: number
}

type Turn = { id: string; chat_id: string; typed: string }
type Made = { id: string; type: string; title: string; created_at: string; chat_turn_id: string }

/** Backfills one person. Safe to run twice: a turn or thing that already has its memory is skipped. */
export async function backfillPerson(db: AdminClient, store: ChatMemoryStore, userId: string): Promise<BackfillResult> {
  const turns = (((await db.from('chat_turns').select('id, chat_id, typed').eq('user_id', userId).eq('kind', 'person').is('superseded_at', null).order('created_at', { ascending: true })).data as Turn[] | null) ?? [])
  const made = (((await db.from('artifacts').select('id, type, title, created_at, chat_turn_id').eq('user_id', userId).not('chat_turn_id', 'is', null)).data as Made[] | null) ?? [])
  const chatOfTurn = new Map(turns.map((t) => [t.id, t.chat_id]))
  const have = new Set((await store.getAll(userId)).map((m) => `${m.metadata?.scope}:${m.metadata?.turn_id}:${m.metadata?.id ?? ''}`))

  let written = 0
  let failed = 0
  for (const t of turns) {
    const mine = made.filter((m) => m.chat_turn_id === t.id)
    const todoMade = mine.filter((m) => !have.has(`chat.made:${t.id}:${m.id}`))
    const todoSaid = !have.has(`chat.said:${t.id}:`)
    if (!todoSaid && todoMade.length === 0) continue
    const out = await writeTurnMemories(store, userId, { chatId: t.chat_id, turnId: t.id, typed: todoSaid ? t.typed : undefined, attached: [], made: todoMade, decided: [] })
    written += out.written
    failed += out.failed
  }
  const expected = turns.length + made.filter((m) => chatOfTurn.has(m.chat_turn_id)).length
  const held = (await store.getAll(userId)).filter((m) => (m.metadata?.scope === 'chat.said' || m.metadata?.scope === 'chat.made') && chatOfTurn.has(String(m.metadata?.turn_id))).length
  return { expected, held, written, failed }
}

async function main() {
  const { createAdminClient } = await import('@/lib/harness/supabase-admin')
  const { getMemoryStore } = await import('@/lib/memory/mem0-store')
  const db = createAdminClient()
  // ponytail: the store's per-item delete is K15's; the real store satisfies ChatMemoryStore once it lands.
  const store = getMemoryStore() as ChatMemoryStore
  const only = process.argv[2]
  const ids = only ? [only] : [...new Set(((await db.from('chats').select('user_id')).data as { user_id: string }[] | null)?.map((r) => r.user_id) ?? [])]
  let bad = 0
  for (const id of ids) {
    const r = await backfillPerson(db, store, id)
    console.log(`${id}: expected ${r.expected}, held ${r.held}, written ${r.written}, failed ${r.failed}`)
    if (r.held !== r.expected || r.failed > 0) bad++
  }
  if (bad > 0) {
    console.error(`${bad} person(s) do not match their expected counts`)
    process.exit(1)
  }
}

if (process.argv[1]?.endsWith('memory-backfill.ts')) void main()
