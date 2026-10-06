// The relay's two doors into the rest of the app. The model ladder (K14) calls
// these and nothing else in lib/relay:
//   relayLive(rung, userId)              can this rung be offered at all, right now
//   relayChatModel(opts)                 the chat model for a step pinned to R1 or R2
//
// "This computer" and "This browser" stay hidden on the hosted app until the owner
// has run the spike that proves them (SP2, SP1). Until then only the owner's own
// account can reach a carrier.

import { estimatePromptTokens, reserveSpend, settleSpend } from '@/lib/harness/spend'
import type { AdminClient } from '@/lib/harness/types'
import { RelayChatModel, type RelayChatModelFields, type RelaySpendNote } from './chat-model'
import type { RelayRung } from './protocol'

export { RelayChatModel } from './chat-model'
export { RelayCeilingError, RelayJobError, RelayWaitError, type RelayRung } from './protocol'

/** Each rung flips to true in the pull request that records its spike result (SP2 for R2, SP1 for R1). */
export const RELAY_LIVE: Record<RelayRung, boolean> = { R1: false, R2: false }

/** True when the rung is live for everyone, or this is the owner's own account (the spikes). */
export function relayLive(rung: RelayRung, userId: string): boolean {
  return RELAY_LIVE[rung] || (!!process.env.OWNER_USER_ID && userId === process.env.OWNER_USER_ID)
}

/** A relayed call spends nothing; it is still one row in the ledger, so the door share counts it. */
async function recordRelayCall(admin: AdminClient, n: RelaySpendNote): Promise<void> {
  const model = n.rung === 'R2' ? 'relay:this-computer' : 'relay:this-browser'
  const promptTokens = estimatePromptTokens(n.promptText)
  const completionTokens = estimatePromptTokens(n.completionText)
  const held = await reserveSpend(admin, {
    userId: n.userId,
    model,
    promptTokens,
    maxTokens: completionTokens,
    rung: n.rung,
    step: n.stepId,
  })
  await settleSpend(admin, held, { model, promptTokens, completionTokens })
}

export function relayChatModel(opts: RelayChatModelFields): RelayChatModel {
  return new RelayChatModel({ ...opts, onAnswer: opts.onAnswer ?? ((n) => recordRelayCall(opts.admin, n)) })
}
