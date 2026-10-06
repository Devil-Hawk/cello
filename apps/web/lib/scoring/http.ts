// What every scoring route does with a failure, in one place, so a missing key, a
// spent budget and a bad request read the same on every screen.

import { NextResponse } from 'next/server'
import { MissingKeyError } from '@/lib/harness/llm'
import { BudgetCapError } from '@/lib/harness/spend'
import { missingOpenRouterMessage, type KeyPresence } from '@/lib/harness/llm-key-message'
import { ScoringInputError } from './index'

export const BUDGET_MESSAGE = "This month's AI budget is used up, so nothing new was picked."

/** The response for a failure the route knows how to explain. Anything else is rethrown as a plain 500. */
export function scoringErrorResponse(err: unknown, keys: KeyPresence): NextResponse {
  if (err instanceof ScoringInputError) return NextResponse.json({ error: err.message }, { status: 400 })
  if (err instanceof MissingKeyError) return NextResponse.json({ error: missingOpenRouterMessage(keys), skippedReason: 'no-llm-key' }, { status: 400 })
  if (err instanceof BudgetCapError) return NextResponse.json({ error: BUDGET_MESSAGE, skippedReason: 'budget' }, { status: 402 })
  console.error('[scoring] request failed', err)
  return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
}
