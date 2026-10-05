// The tool registry: the twelve things Cello can do, defined once.
//
// The same list builds the tools the agents use (langchain.ts) and Cello's own MCP
// server (mcp.ts), so a name, a description or an argument can never drift between
// them. Sizes and defaults are in the schemas: every read tool takes response_format
// and limit, every write tool takes an idempotency key, and every error says what to
// do next. No name contains "run" or "thread".
//
// The thirteen names are twelve tools: create_artifact and update_artifact are one
// item, a document written and a document revised.

import { CELLO_TOOL_NAMES, UNTRUSTED_TOOL_NAMES } from '../tool-names'
import { SCHEDULED_TASKS_ON } from '../schedule-schemas'
import type { CelloTool } from './common'
import { createArtifactTool, updateArtifactTool } from './artifacts'
import { pipeline, requestApproval, scheduleTask } from './actions'
import { myProfile, remember } from './memory'
import { people, research, searchKnowledge } from './research'
import { findRoles, getRole, triageRole } from './roles'

// The type of each tool keeps its own argument shape; the list holds them all.
export const CELLO_TOOLS: readonly CelloTool<any>[] = [
  findRoles,
  getRole,
  triageRole,
  research,
  people,
  myProfile,
  remember,
  createArtifactTool,
  updateArtifactTool,
  pipeline,
  requestApproval,
  // Scheduling is closed until the instructions that say what a task may do ship (SCHEDULED_TASKS_ON).
  ...(SCHEDULED_TASKS_ON ? [scheduleTask] : []),
  searchKnowledge,
]

// A drift between the list above and the names the guard middleware knows would let an untrusted result through unquoted.
for (const tool of CELLO_TOOLS) {
  if (!CELLO_TOOL_NAMES.includes(tool.name)) throw new Error(`tool ${tool.name} is not in CELLO_TOOL_NAMES`)
  if (tool.untrusted !== UNTRUSTED_TOOL_NAMES.has(tool.name)) throw new Error(`tool ${tool.name}: untrusted flag and UNTRUSTED_TOOL_NAMES disagree`)
}

export const toolByName = (name: string) => CELLO_TOOLS.find((t) => t.name === name)

/** The tools served over MCP: all but the ones that need a conversation. */
export const MCP_TOOLS = CELLO_TOOLS.filter((t) => t.mcp)

/** The tools a Researcher may hold. It reads, it never writes. */
export const RESEARCHER_TOOL_NAMES = ['search_knowledge', 'people'] as const
