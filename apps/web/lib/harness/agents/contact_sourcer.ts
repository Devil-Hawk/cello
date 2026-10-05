// Agent: contact_sourcer — source PLAUSIBLE people/contacts at a company for a
// role, so outreach (see lib/harness/agents/outreach.ts, owned by another
// workstream — this file only DRAFTS-supporting data, it never sends anything)
// has someone real-ish to address. Free path works with NO external keys;
// Hunter/Apollo are opt-in BYOK enhancements. See lib/contacts/sources.ts for
// the full design and the provenance/verified guarantees.
//
// Wired: 'contact_sourcer' is in AGENT_TYPES/STEP_AGENT_TYPES (schemas.ts) and
// the registry (registry.ts), and the schemas here match the agentSchemas map
// 1:1. It is also callable directly: app/api/contacts/source/route.ts calls the
// SAME core (sourceContactsForCompany) this file wraps, so both paths stay in
// sync.
//
// SAFETY: this agent only ever calls sourceContactsForCompany, which persists
// contacts rows and NEVER sends an email or exposes a send path. Turning a
// sourced contact into an actual sent message stays a separate, human-gated
// step (see app/api/outreach/*, owned by another workstream).

import { z } from 'zod'
import type { AgentFn } from '../types'
import { sourceContactsForCompany } from '@/lib/contacts/sources'
import { readContactProviderKeys } from '@/lib/contacts/keys'

export const ContactSourcerInput = z.object({
  companyId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(25).optional(),
})

export const ContactSourcerOutput = z.object({
  companyId: z.string(),
  found: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  skippedExisting: z.number().int().nonnegative(),
  freePathOnly: z.boolean(),
  providers: z.array(
    z.object({
      provider: z.enum(['hunter', 'apollo']),
      ran: z.boolean(),
      reason: z.enum(['no-key', 'no-domain', 'error']).optional(),
      found: z.number().int().nonnegative(),
    })
  ),
  contactIds: z.array(z.string()),
  /**
   * Set whenever this step found/inserted nothing — mirrors matcher's
   * skippedReason contract (lib/harness/schemas.ts MatcherOutput): "no
   * candidates" is an expected, clearly-labeled outcome here too, never a
   * raw thrown error a downstream step has to guess about.
   */
  skippedReason: z.string().optional(),
})

export const contact_sourcer: AgentFn = async (ctx) => {
  const input = ContactSourcerInput.parse(ctx.input ?? {})
  const providerKeys = await readContactProviderKeys(ctx.admin, ctx.userId)

  try {
    const result = await sourceContactsForCompany({
      client: ctx.admin,
      userId: ctx.userId,
      companyId: input.companyId,
      jobId: input.jobId ?? null,
      hunterKey: providerKeys.hunter,
      apolloKey: providerKeys.apollo,
      limit: input.limit,
      signal: ctx.signal,
    })
    const output = {
      companyId: result.companyId,
      found: result.candidates.length,
      inserted: result.inserted.length,
      skippedExisting: result.skippedExisting,
      freePathOnly: result.freePathOnly,
      providers: result.providers,
      contactIds: result.inserted.map((c) => c.id),
      ...(result.candidates.length === 0 ? { skippedReason: 'no-candidates-found' } : {}),
    }
    return { output, tokensUsed: 0 }
  } catch (e) {
    // "Upstream produced nothing" / "company not found" degrade to a labeled,
    // schema-valid output instead of a raw thrown error reaching the executor.
    return {
      output: {
        companyId: input.companyId,
        found: 0,
        inserted: 0,
        skippedExisting: 0,
        freePathOnly: !providerKeys.hunter && !providerKeys.apollo,
        providers: [],
        contactIds: [],
        skippedReason: e instanceof Error ? e.message : 'contact sourcing failed',
      },
      tokensUsed: 0,
    }
  }
}
