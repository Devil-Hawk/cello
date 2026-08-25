// Agent: contact_sourcer — source PLAUSIBLE people/contacts at a company for a
// role, so outreach (see lib/harness/agents/outreach.ts, owned by another
// workstream — this file only DRAFTS-supporting data, it never sends anything)
// has someone real-ish to address. Free path works with NO external keys;
// Hunter/Apollo are opt-in BYOK enhancements. See lib/contacts/sources.ts for
// the full design and the provenance/verified guarantees.
//
// COORDINATION NOTE (not yet wired into the DAG): 'contact_sourcer' is NOT in
// AGENT_TYPES/STEP_AGENT_TYPES (lib/harness/schemas.ts) or registry.ts
// (lib/harness/registry.ts) — those are owned by the engine workstream. This
// file is shaped exactly like every other AgentFn (lib/harness/types.ts) so
// wiring it in is a small, mechanical change once that workstream is ready:
//   1. add 'contact_sourcer' to AGENT_TYPES + STEP_AGENT_TYPES in schemas.ts
//   2. add ContactSourcerInput/ContactSourcerOutput (below) to schemas.ts's
//      agentSchemas map (the zod shapes here already match 1:1)
//   3. import { contact_sourcer } from './agents/contact_sourcer' and add it
//      to the `registry` map in registry.ts
// Until then this agent is fully callable directly — see
// app/api/contacts/source/route.ts, which calls the SAME core
// (sourceContactsForCompany) this file wraps, so both paths stay in sync.
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
