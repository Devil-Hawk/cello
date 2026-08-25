// Build a budget-agnostic LlmRunner for request-context outreach drafting.
//
// The harness executor hands agents a metered `ctx.llm`; outside the harness
// (the outreach API routes) we build an equivalent runner over the user's
// decrypted OpenRouter key using the same callLlm primitive.

import { callLlm } from '@/lib/harness/llm'
import type { LlmRunner } from '@/lib/harness/types'

/**
 * Returns an LlmRunner backed by the user's OpenRouter key, or null when no key
 * is configured (callers fall back to a deterministic template).
 */
export function makeLlmRunner(openrouterKey: string | undefined): LlmRunner | null {
  if (!openrouterKey) return null
  return (opts) => callLlm({ openrouter: openrouterKey }, opts)
}
