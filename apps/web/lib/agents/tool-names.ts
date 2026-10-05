// The tool names, in one place with no imports, so the guard middleware can know
// which results are untrusted without loading every handler. The registry
// (lib/agents/tools/registry.ts) asserts at load that it matches this list.

export const CELLO_TOOL_NAMES = [
  'find_roles',
  'get_role',
  'triage_role',
  'research',
  'people',
  'my_profile',
  'remember',
  'create_artifact',
  'update_artifact',
  'pipeline',
  'request_approval',
  'schedule_task',
  'search_knowledge',
] as const

export type CelloToolName = (typeof CELLO_TOOL_NAMES)[number]

/**
 * Tools whose results carry text somebody else wrote: job posts, web pages,
 * other people's names and emails, the open web. Their results reach the model
 * quoted as data (CelloUntrusted). The Researcher's own read primitives are in
 * the list too, and so is every tool from a user's MCP server (prefix below).
 */
export const UNTRUSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'find_roles',
  'get_role',
  'research',
  'people',
  'search_knowledge',
  'web_search',
  'read_page',
])

/** User MCP tools are named mcp__<server>__<tool> (prefixed by the adapter). */
export const MCP_TOOL_PREFIX = 'mcp__'

export const isUntrustedTool = (name: string): boolean =>
  UNTRUSTED_TOOL_NAMES.has(name) || name.startsWith(MCP_TOOL_PREFIX)
