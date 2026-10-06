// Proposals: what Chat may suggest and how Confirm applies it (agents-v3 1.5, blueprint 5.3).
// Chat never changes a setting, a saved answer or a routine itself. It stores a proposal; the person's Confirm
// re-reads the stored payload and applies exactly that through the command that owns the change.
//
//   - each kind is a strict schema, so an unknown key is refused at propose and again at confirm;
//   - settings that are the person's alone (pipeline, following, watching, send, autonomy) are refused by name;
//   - the quote a proposal rests on must be inside what the person typed in this chat, word for word. A selection
//     quoted from an answer is not typed, so it never satisfies the check;
//   - the card shows code's rendering of the stored payload, never the model's words;
//   - a kind whose command is not registered is refused at propose, so no card appears that Confirm cannot apply.

import { z } from 'zod'
import type { AdminClient } from '@/lib/harness/types'
import type { Refusal } from './types'

const strings = (max: number) => z.array(z.string().max(max)).max(10).optional()

const SCHEMAS = {
  search: z
    .strictObject({
      exclude_keywords: strings(40),
      include_titles: strings(60),
      exclude_titles: strings(60),
      locations: strings(60),
      remote: z.enum(['only', 'also', 'no']).optional(),
      pay_floor: z.number().int().min(0).max(1_000_000).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, 'Nothing to change'),
  answers: z.strictObject({ question_id: z.uuid(), value: z.string().max(200) }),
  start: z.strictObject({ role_ids: z.array(z.uuid()).min(1).max(10) }),
  material: z.strictObject({ text: z.string().max(2000), company_id: z.uuid().optional() }),
  instructions: z.strictObject({ text: z.string().max(300), local_time: z.string().regex(/^\d\d:\d\d$/), every: z.enum(['day', 'week']) }),
  learned: z.strictObject({ text: z.string().max(200), effect: z.enum(['rank.want', 'draft.style']) }),
}
export type ProposalKind = keyof typeof SCHEMAS
const KINDS = Object.keys(SCHEMAS) as ProposalKind[]

/** Settings that only the person changes, by their own click in Settings. */
const GUARDED = new Set(['pipeline', 'following', 'watching', 'send', 'autonomy'])

/** The command a kind is applied through (search.update, answers.answer, ...), supplied by whoever wires Chat. */
export type ApplyTarget = (db: AdminClient, userId: string, payload: Record<string, unknown>) => Promise<void>
export type ApplyTargets = Partial<Record<ProposalKind, ApplyTarget>>

const refuse = (error: string, fix: string): Refusal => ({ ok: false, error, fix })
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function parse(kind: string, payload: unknown): { ok: true; kind: ProposalKind; value: Record<string, unknown> } | Refusal {
  const k = KINDS.find((x) => x === kind)
  if (!k) return refuse('That is not something Cello can propose.', 'Name the setting or the thing you want changed.')
  if (payload && typeof payload === 'object' && Object.keys(payload).some((key) => GUARDED.has(key))) {
    return refuse('That setting is yours alone.', 'Change it yourself in Settings.')
  }
  const parsed = SCHEMAS[k].safeParse(payload)
  return parsed.success ? { ok: true, kind: k, value: parsed.data as Record<string, unknown> } : refuse('That proposal has a field Cello does not use.', 'Propose again with the fields it names.')
}

/** The sentence on the Confirm card, from the stored payload and nothing else. */
export function renderProposal(kind: ProposalKind, p: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '')
  switch (kind) {
    case 'search':
      return [
        p.exclude_keywords && `Stop showing roles with: ${list(p.exclude_keywords)}`,
        p.include_titles && `Show titles: ${list(p.include_titles)}`,
        p.exclude_titles && `Hide titles: ${list(p.exclude_titles)}`,
        p.locations && `Places: ${list(p.locations)}`,
        p.remote && `Remote: ${p.remote}`,
        p.pay_floor !== undefined && `Pay at least ${p.pay_floor}`,
      ]
        .filter(Boolean)
        .join('. ')
    case 'answers':
      return `Save this answer: ${p.value}`
    case 'start':
      return `Start ${(p.role_ids as string[]).length} role${(p.role_ids as string[]).length === 1 ? '' : 's'}`
    case 'material':
      return `Add to your material: ${p.text}`
    case 'instructions':
      return `Every ${p.every} at ${p.local_time}: ${p.text}`
    case 'learned':
      return `Remember: ${p.text}`
  }
}

export type ProposeResult = { ok: true; id: string; card: string } | Refusal

export async function propose(
  db: AdminClient,
  userId: string,
  input: { chatId: string; turnId: string; kind: string; payload: unknown; quote?: string },
  targets: ApplyTargets
): Promise<ProposeResult> {
  const parsed = parse(input.kind, input.payload)
  if (!parsed.ok) return parsed
  if (!targets[parsed.kind]) return refuse('Cello cannot apply that yet.', 'Make the change yourself.')

  // A start rests on roles Cello was shown; every other kind rests on the person's own typed words.
  if (parsed.kind !== 'start') {
    const quote = norm(input.quote ?? '')
    const { data } = await db.from('chat_turns').select('typed').eq('chat_id', input.chatId).eq('user_id', userId).eq('kind', 'person').is('superseded_at', null)
    const typed = ((data as { typed: string | null }[] | null) ?? []).map((t) => norm(t.typed ?? ''))
    if (quote.length < 6 || !typed.some((t) => t.includes(quote))) {
      return refuse('That quote is not in anything you typed in this chat.', 'Say it in your own words, then Cello can propose it.')
    }
  }

  const { data, error } = await db
    .from('proposals')
    .insert({
      user_id: userId,
      kind: parsed.kind,
      payload: parsed.value,
      quote: input.quote ?? null,
      channel: 'chat',
      origin: 'model',
      prov: { turn_id: input.turnId },
      chat_id: input.chatId,
      turn_id: input.turnId,
    })
    .select('id')
    .single()
  if (error || !data) return refuse('Could not save that proposal.', 'Try again.')
  return { ok: true, id: (data as { id: string }).id, card: renderProposal(parsed.kind, parsed.value) }
}

/** Applies exactly the stored payload, once. Run as the person, from their click. */
export async function confirmProposal(db: AdminClient, userId: string, id: string, targets: ApplyTargets): Promise<{ ok: true } | Refusal> {
  const { data: row } = await db.from('proposals').select('id, kind, payload').eq('id', id).eq('user_id', userId).eq('status', 'open').maybeSingle()
  if (!row) return refuse('That proposal is already decided or is not yours.', 'Open the chat again.')
  const stored = row as { kind: string; payload: unknown }
  const parsed = parse(stored.kind, stored.payload)
  if (!parsed.ok) return parsed
  const target = targets[parsed.kind]
  if (!target) return refuse('Cello cannot apply that yet.', 'Make the change yourself.')

  // Claim it first, so a second click cannot apply it twice; give it back if the change fails.
  const now = new Date().toISOString()
  const { data: claimed } = await db.from('proposals').update({ status: 'confirmed', decided_at: now, confirmed_at: now }).eq('id', id).eq('user_id', userId).eq('status', 'open').select('id')
  if (((claimed as unknown[] | null) ?? []).length !== 1) return refuse('That proposal is already decided.', 'Open the chat again.')
  try {
    await target(db, userId, parsed.value)
  } catch {
    await db.from('proposals').update({ status: 'open', decided_at: null, confirmed_at: null }).eq('id', id).eq('user_id', userId)
    return refuse('The change did not go through.', 'Try Confirm again.')
  }
  return { ok: true }
}

export async function dismissProposal(db: AdminClient, userId: string, id: string): Promise<{ ok: true } | Refusal> {
  const { data } = await db.from('proposals').update({ status: 'dismissed', decided_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId).eq('status', 'open').select('id')
  return ((data as unknown[] | null) ?? []).length === 1 ? { ok: true } : refuse('That proposal is already decided or is not yours.', 'Open the chat again.')
}
