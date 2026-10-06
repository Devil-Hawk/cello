// Today's MCP tools as registry commands (Q6). Cello has always served the 18
// first-party copilot tools to MCP hosts under their own names; hosts that
// already use them keep working. Each tool is one command, `legacy.<tool>`,
// callable only through the assistant door, and mcpView lists it under its old
// name. New reads join /api/mcp as ordinary registry commands; these retire as
// the commands that replace them ship (K15, K17, K24a).

import { z } from 'zod'
import { COPILOT_TOOLS, type ToolSpec } from '@/lib/harness/copilot-tool-catalog'
import { TOOL_SCHEMAS } from '@/lib/mcp/tool-schemas'
import { defineCommand, type AnyCommand, type CommandContext } from '../define'
import { untrustedText } from '../text'
import { LEGACY_PREFIX } from '../views'

/** The measure each tool answers to (blueprint 13.1). */
const MEASURE: Record<string, string> = {
  list_jobs: 'T3',
  explain_match: 'S3',
  score_jobs: 'S3',
  tailor_cv: 'S5',
  optimize_resume: 'S5',
  draft_outreach: 'S6',
  research_company: 'S13',
  research_companies: 'S13',
  web_search: 'T1',
  source_jobs: 'T1',
  search_kb: 'S12',
  get_application: 'T10',
  list_runs: 'T10',
  list_contacts: 'S18',
  get_dossier: 'T12',
  check_sponsorship: 'T12',
  trigger_run: 'T5',
  remember_preference: 'S16',
}

const FIXED_EGRESS = new Set(['web_search', 'source_jobs', 'research_company', 'research_companies', 'trigger_run'])

const MAX_TEXT = 200_000

/** What an MCP host is told when a tool would send or submit. There is no person
 *  on the other end to confirm it, so it is refused and pointed at the web app. */
export function mcpRefusalText(reason: string): string {
  return `${reason} This cannot be approved over MCP — there is no human to confirm it here. Open the Cello web app and approve it from the copilot chat instead.`
}

async function emailForUser(ctx: CommandContext): Promise<string> {
  const { data } = await ctx.admin().auth.admin.getUserById(ctx.userId)
  return typeof data?.user?.email === 'string' ? data.user.email : ''
}

async function runLegacy(ctx: CommandContext, name: string, args: Record<string, unknown>) {
  // The unconditional submit and send guard, before anything else, every call.
  const { submitOrSendReason } = await import('@/lib/graph/copilot')
  const reason = submitOrSendReason(name, args)
  if (reason) return { text: mcpRefusalText(reason), is_error: true }

  const [{ loadApiKeys }, { dispatchTool }] = await Promise.all([import('@/lib/harness/keys'), import('@/lib/harness/copilot-tools')])
  const admin = ctx.admin()
  const [apiKeys, userEmail] = await Promise.all([loadApiKeys(admin, ctx.userId), emailForUser(ctx)])
  const observation = await dispatchTool({ admin, userId: ctx.userId, userEmail, apiKeys, signal: ctx.signal }, name, args)
  const text = typeof observation === 'string' ? observation : JSON.stringify(observation)
  const is_error = Boolean(observation && typeof observation === 'object' && 'error' in (observation as Record<string, unknown>))
  return { text: text.slice(0, MAX_TEXT), is_error }
}

function legacyCommand(spec: ToolSpec): AnyCommand {
  const shape = TOOL_SCHEMAS[spec.name]
  if (!shape) {
    // Cannot happen outside a drift between the catalog and tool-schemas.ts;
    // app/api/mcp/route.test.ts pins the two lists equal.
    throw new Error(`lib/mcp/tool-schemas.ts has no schema for catalog tool "${spec.name}"`)
  }
  return defineCommand({
    id: `${LEGACY_PREFIX}${spec.name}`,
    label: spec.name,
    input: z.strictObject(shape),
    output: z.object({ text: untrustedText(MAX_TEXT), is_error: z.boolean() }),
    callers: ['assistant'],
    kind: spec.kind === 'read' ? 'code' : 'wf',
    sends: false,
    egress: FIXED_EGRESS.has(spec.name) ? 'fixed' : spec.name === 'remember_preference' ? 'record' : 'none',
    measure: MEASURE[spec.name] ?? 'T12',
    run: (ctx, input) => runLegacy(ctx, spec.name, input as Record<string, unknown>),
  })
}

export const legacyMcpCommands: AnyCommand[] = COPILOT_TOOLS.map(legacyCommand)
