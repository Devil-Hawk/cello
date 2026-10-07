// The spend seam for agent model calls.
//
// CelloSpend (lib/agents/middleware.ts) calls only reserve() before a model call
// and settle() after it. Both are thin: the cap, the ledger rows and the sweeper
// that charges a call nobody settled are reserveSpend and settleSpend in
// lib/harness/spend.ts, the same two every other model call goes through.
//
// A free model (an id ending in ":free") is a rung that costs nothing, so it
// reserves $0. That is also what lets a fallback to a free model succeed after
// the paid cap has been reached.

import type { AdminClient } from '@/lib/harness/types'
import { reserveSpend, rungFor, settleSpend, type SpendOutcome, type SpendReservation } from '@/lib/harness/spend'

export { BudgetCapError } from '@/lib/harness/spend'

export interface ReserveInput {
  admin: AdminClient
  userId: string
  model: string
  promptTokens: number
  maxTokens: number
  traceId?: string
  /** Written on the ledger row so a Chat turn can add up its own cost. */
  chatTurnId?: string
}

export interface Reservation {
  spend: SpendReservation
  admin: AdminClient
}

/** What the call cost (its tokens), or why it failed. */
export type SettleInput = SpendOutcome

/**
 * The error underneath any wrappers. langchain wraps an error thrown inside a
 * middleware in a MiddlewareError (the name and message are kept, the original
 * is the `cause`), so an `instanceof` check against the original class fails
 * after one layer.
 */
export function rootCause(err: unknown): unknown {
  let current = err
  for (let i = 0; i < 8; i++) {
    const cause = (current as { cause?: unknown } | null)?.cause
    if (!cause || cause === current) break
    current = cause
  }
  return current
}

/** True for a BudgetCapError, however many layers wrapped it. */
export function isBudgetCapError(err: unknown): boolean {
  return (rootCause(err) as { name?: unknown } | null)?.name === 'BudgetCapError'
}

/** Reserve the worst-case cost of one model call. Throws BudgetCapError when the cap is reached. */
export async function reserve(input: ReserveInput): Promise<Reservation> {
  const spend = await reserveSpend(input.admin, {
    userId: input.userId,
    model: input.model,
    promptTokens: input.promptTokens,
    maxTokens: input.maxTokens,
    rung: rungFor('openrouter', input.model),
    step: 'agent-turn',
    traceId: input.traceId,
  })
  if (input.chatTurnId && spend.id) await input.admin.from('llm_spend').update({ chat_turn_id: input.chatTurnId }).eq('id', spend.id)
  return { spend, admin: input.admin }
}

/** Record what the call actually cost, or that it failed. Never throws. */
export async function settle(reservation: Reservation, outcome: SettleInput): Promise<void> {
  await settleSpend(reservation.admin, reservation.spend, outcome)
}
