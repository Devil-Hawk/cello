// Zod input shapes for Cello's own 19 first-party copilot tools, keyed by the
// exact names lib/harness/copilot-tool-catalog.ts's COPILOT_TOOLS registry
// uses — the SAME registry dispatchTool (lib/harness/copilot-tools.ts)
// switches on and app/api/mcp/route.ts enumerates for MCP's tools/list.
//
// WHY THIS FILE EXISTS (ponytail: nothing here to reuse)
//   The catalog only carries a human-readable `signature` string per tool —
//   there is no per-tool zod anywhere in the repo to import instead of
//   re-declaring (checked: no file defines argument schemas keyed by these
//   tool names). This is that one, hand-written from each tool's own dispatch
//   handler in copilot-tools.ts (the str()/clampLimit()/Array.isArray reads
//   at the top of each `do*`/list*/get* function ARE the real argument
//   contract; every field below matches one of those reads, not a guess).
//
// LOOSE ON PURPOSE. Every field is optional unless the handler itself refuses
// to run without it (`if (!jobId) return { error: ... }`) — dispatchTool
// never throws on a malformed args object (see its own doc: "Always resolves
// ... never throws"), so an MCP client that under- or mis-types an argument
// gets the SAME actionable `{error}` observation a copilot tool call gets,
// not an MCP-level schema-validation rejection that hides the tool's own
// error message.
//
// TOOL_SCHEMA_NAMES/COPILOT_TOOL_NAMES below (imported by
// app/api/mcp/route.test.ts) are what keep this file from silently drifting
// out of sync with COPILOT_TOOLS: a tool added to the catalog and forgotten
// here fails that test's set-equality check rather than shipping an MCP tool
// list one short.

import { z, type ZodRawShape } from 'zod'
import { COPILOT_TOOLS } from '../harness/copilot-tool-catalog'

const jobId = z.string().describe('A real jobId from list_jobs/source_jobs/score_jobs — never invented.')
const companyId = z.string().describe('A real companyId from list_jobs/source_jobs — never invented.')
const limit = z.number().int().positive().optional().describe('Caps how many results come back; each tool has its own default and hard max.')
const query = z.string().optional().describe('Free-text filter/search query.')
/** search_kb/web_search's own required variant — these two tools refuse to
 *  run without a query, unlike everything else above. */
const requiredQuery = z.string().describe('The search query — required.')

/** ZodRawShape per tool (an object of field schemas, the shape registerTool's
 *  inputSchema wants — NOT a z.object() wrapper). Keys MUST equal
 *  COPILOT_TOOLS' tool names exactly; TOOL_SCHEMA_NAMES below is the pin. */
export const TOOL_SCHEMAS: Record<string, ZodRawShape> = {
  list_jobs: {
    query,
    dreamOnly: z.boolean().optional().describe('Restrict to dream companies only.'),
    fresh: z.boolean().optional().describe('Restrict to just-discovered roles.'),
    limit,
  },
  list_runs: {},
  explain_match: { jobId },
  get_application: { jobId: jobId.optional() },
  list_contacts: { query },
  get_dossier: { companyId },
  check_sponsorship: {
    companyNames: z.array(z.string()).optional().describe('Company names to check — batch form.'),
    companyName: z.string().optional().describe('A single company name — shorthand for companyNames.'),
  },
  web_search: { query: requiredQuery, limit },
  source_jobs: { query, limit },
  score_jobs: {
    query,
    limit,
    jobIds: z.array(z.string()).optional().describe('Explicit jobIds to score — skips candidate selection.'),
  },
  optimize_resume: { jobId },
  tailor_cv: { jobId },
  draft_outreach: { jobId: jobId.optional(), contactId: z.string().optional() },
  research_company: { companyId },
  research_companies: {
    companyIds: z.array(z.string()).describe('Company ids to research, up to the tool\'s batch cap.'),
    limit,
  },
  prep_interview: { jobId },
  trigger_run: { goal: z.string().describe('The whole-DAG goal to plan and execute in the background.') },
  search_kb: { query: requiredQuery, limit },
  remember_preference: { text: z.string().describe('One short sentence, in the user\'s own words.') },
}

/** Set-equality pin: every COPILOT_TOOLS name has a schema here, and vice
 *  versa. Enforced by app/api/mcp/route.test.ts, not here — this file stays
 *  pure data (no test runner import) so app/(app)/copilot's client bundle
 *  chain, if it ever imports this, never pulls in vitest. */
export const TOOL_SCHEMA_NAMES = Object.keys(TOOL_SCHEMAS)
export const COPILOT_TOOL_NAMES = COPILOT_TOOLS.map((t) => t.name)
