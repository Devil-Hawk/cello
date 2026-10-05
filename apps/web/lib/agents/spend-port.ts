// The spend seam for agent model calls.
//
// CelloSpend (lib/agents/middleware.ts) calls only reserve() before a model call
// and settle() after it. Everything about how money is counted lives behind
// these two functions, so the spend package can replace the bodies without
// touching an agent file. This file adds no budget check of its own: the bodies
// below call the checks and the ledger that already exist (assertWithinBudget
// and recordSpend in lib/harness/spend.ts). When the atomic reserve and settle
// from the security package land, the bodies become calls to them.
//
// A free model (an id ending in ":free") costs nothing, so it reserves and
// settles nothing. That is also what lets a fallback to a free model succeed
// after the paid cap has been reached.

import type { AdminClient } from '@/lib/harness/types'
import { assertWithinBudget, estimateCostUsd, recordSpend } from '@/lib/harness/spend'

export { BudgetCapError } from '@/lib/harness/spend'

export interface ReserveInput {
  admin: AdminClient
  userId: string
  model: string
  promptTokens: number
  maxTokens: number
  traceId?: string
}

export interface Reservation {
  /** Handle from the ledger, or null when nothing was reserved (a free model). */
  id: string | null
  userId: string
  admin: AdminClient
  /** Worst-case cost that was reserved, USD. */
  reservedUsd: number
}

export interface SettleInput {
  model: string
  promptTokens: number
  completionTokens: number
}

const isFree = (model: string) => model.endsWith(':free')

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
  if (isFree(input.model)) return { id: null, userId: input.userId, admin: input.admin, reservedUsd: 0 }
  await assertWithinBudget(input.admin, input.userId)
  return {
    id: null,
    userId: input.userId,
    admin: input.admin,
    reservedUsd: estimateCostUsd(input.model, input.promptTokens, input.maxTokens),
  }
}

/**
 * Record what the call actually cost. A call that failed settles with zero
 * tokens, which releases the reservation without a charge.
 */
export async function settle(reservation: Reservation, usage: SettleInput): Promise<void> {
  if (isFree(usage.model)) return
  if (usage.promptTokens === 0 && usage.completionTokens === 0) return
  await recordSpend(reservation.admin, reservation.userId, usage.model, usage.promptTokens, usage.completionTokens)
}
