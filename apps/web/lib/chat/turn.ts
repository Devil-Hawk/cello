// One Chat turn, from the person's words to the stored answer. The model loop is injected (`agent`), so this is the
// part that does not change when the engine does:
//
//   1. the typed words are stored first, as a person turn, before anything runs (own-words checks read only these);
//   2. the screen message is built by code from the tiles, recalled things and any quoted selection;
//   3. the agent answers with parts; each is checked against what its tools returned, sent back once when it fails,
//      then dropped with a line (answer.ts);
//   4. only parts that passed are stored and shown, with their links and the turn's disclosure;
//   5. memories are written by code from the rows, and the chat's last turn and title are updated.
//
// A model that fails after step 1 leaves the person's turn in place and no answer: "Nothing was changed."

import type { AdminClient } from '@/lib/harness/types'
import type { Ran } from '@/lib/models/choice'
import { settleAnswer, type ModelAnswer, type Settled, type TurnResult } from './answer'
import { activeTiles, ledgerKey } from './attach'
import { buildDisclosure, type Disclosure } from './disclosure'
import { writeTurnMemories, type ChatMemoryStore, type TurnMemories } from './memory'
import { getObject } from './objects'
import type { RecallHit } from './recall'
import { screenMessage } from './screen'
import { refId, type ObjectReader, type Refusal } from './types'

export interface AgentInput {
  chatId: string
  /** The person's turn: what tools write on (artifacts, spend, workers) point at it. */
  turnId: string
  screen: string | null
  typed: string
  /** The failures of the first answer, when this is the one retry. */
  feedback: string | null
  /** Ledger keys of the things tools have returned this turn: Cello may attach only these (attach.ts). */
  returned: ReadonlySet<string>
}

export interface AgentOutput {
  answer: ModelAnswer
  /** What the tools returned this run, each with the thing it was about. */
  results: TurnResult[]
  ran?: Ran
  tools?: Disclosure['tools']
  sources?: Disclosure['sources']
  made?: TurnMemories['made']
  decided?: TurnMemories['decided']
}

export interface TurnDeps {
  db: AdminClient
  agent: (input: AgentInput) => Promise<AgentOutput>
  store?: ChatMemoryStore | null
  get?: ObjectReader
  isDemo?: boolean
  now?: () => Date
}

export type TurnResultOut = { ok: true; turnId: string; answerId: string; settled: Settled } | (Refusal & { turnId?: string })

const TITLE_MAX = 80
const TYPED_MAX = 20_000

export async function runChatTurn(
  deps: TurnDeps,
  input: { userId: string; chatId: string; typed: string; quoted?: { text: string; turn_id: string } | null; recalled?: RecallHit[] }
): Promise<TurnResultOut> {
  const { db } = deps
  const { userId, chatId } = input
  const now = deps.now ?? (() => new Date())
  const startedAt = now()
  const typed = input.typed.trim()
  if (!typed || typed.length > TYPED_MAX) return { ok: false, error: 'There is nothing to send.', fix: `Type up to ${TYPED_MAX.toLocaleString('en-US')} characters.` }

  const { data: chat } = await db.from('chats').select('id, title').eq('id', chatId).eq('user_id', userId).maybeSingle()
  if (!chat) return { ok: false, error: 'That chat was not found.', fix: 'Open it from your chats.' }

  // 1. The typed words first. A selection quoted from an answer is kept apart and is never these words.
  const { data: person, error } = await db
    .from('chat_turns')
    .insert({ user_id: userId, chat_id: chatId, kind: 'person', typed, origin: 'person', quoted: input.quoted ?? null })
    .select('id')
    .single()
  if (error || !person) return { ok: false, error: 'Could not save your message.', fix: 'Try again.' }
  const turnId = (person as { id: string }).id
  if (!(chat as { title: string }).title) await db.from('chats').update({ title: typed.replace(/\s+/g, ' ').slice(0, TITLE_MAX) }).eq('id', chatId).eq('user_id', userId)

  // 2. The screen message, reading each tile once.
  const reads = new Map<string, ReturnType<ObjectReader>>()
  const read = deps.get ?? getObject
  const get: ObjectReader = (d, u, kind, ref) => {
    const key = ledgerKey(kind, ref)
    if (!reads.has(key)) reads.set(key, read(d, u, kind, ref))
    return reads.get(key) as ReturnType<ObjectReader>
  }
  const tiles = await activeTiles(db, userId, chatId)
  const attached = tiles.map((t) => ({ kind: t.kind, ref: refId(t.kind, t.ref) }))
  const screen = await screenMessage(db, userId, chatId, { quoted: input.quoted, recalled: input.recalled, get })

  // 3. The agent answers; the parts are checked against what its tools returned.
  const returned = new Set<string>()
  let results: TurnResult[] = []
  let last: AgentOutput | null = null
  const ask = async (feedback: string | null) => {
    const out = await deps.agent({ chatId, turnId, screen, typed, feedback, returned })
    last = out
    results = results.concat(out.results)
    for (const r of out.results) if (r.object) returned.add(ledgerKey(r.object.kind, r.object.ref))
    return out.answer
  }
  let settled: Settled
  try {
    settled = await settleAnswer(ask, () => ({ attached, results }))
  } catch {
    return { ok: false, turnId, error: 'Cello could not finish this. Nothing was changed.', fix: 'Try again.' }
  }
  const out = last as AgentOutput | null

  // 4. Only what passed is stored, with the turn's disclosure.
  const disclosure = out?.ran ? await buildDisclosure(db, userId, turnId, { ran: out.ran, tools: out.tools ?? [], sources: out.sources ?? [], startedAt, endedAt: now() }) : null
  const { data: answer, error: answerError } = await db
    .from('chat_turns')
    .insert({
      user_id: userId,
      chat_id: chatId,
      kind: 'cello',
      answer: settled.text,
      origin: 'model',
      prov: { step: 'chat', turn_id: turnId },
      parts: settled.parts,
      links: settled.links,
      ran: out?.ran ?? null,
      disclosure,
    })
    .select('id')
    .single()
  if (answerError || !answer) return { ok: false, turnId, error: 'Cello could not save this answer.', fix: 'Try again.' }
  await db.from('chats').update({ last_turn_at: now().toISOString() }).eq('id', chatId).eq('user_id', userId)

  // 5. Memories from the rows, by code. A failed write never fails the turn.
  if (deps.store) {
    const names = (await Promise.all(tiles.map((t) => get(db, userId, t.kind, t.ref)))).flatMap((o) => (o ? [o.title] : []))
    await writeTurnMemories(deps.store, userId, { chatId, turnId, typed, attached: names, made: out?.made ?? [], decided: out?.decided ?? [] }, deps.isDemo ?? false)
  }
  return { ok: true, turnId, answerId: (answer as { id: string }).id, settled }
}
