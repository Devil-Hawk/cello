// The command registry. Every action on every object is one entry here, and the
// views Chat, MCP, A2A and workflows see are filtered from it (./views.ts).
//
// Each lane owns one defs file and registers its commands in it once this is on
// main. Nothing else may add to COMMANDS.

import type { AnyCommand } from './define'
import { coreCommands } from './defs/core'
import { relevanceCommands } from './defs/relevance'
import { directoryCommands } from './defs/directory'
import { chatCommands } from './defs/chat'
import { pipelineCommands } from './defs/pipeline'
import { workflowsCommands } from './defs/workflows'
import { peopleCommands } from './defs/people'
import { materialCommands } from './defs/material'
import { resumeCommands } from './defs/resume'
import { legacyMcpCommands } from './defs/legacy-mcp'
import { a2aViewOf, agentViewOf, mcpViewOf, workflowViewOf } from './views'

export const COMMANDS: readonly AnyCommand[] = [
  ...coreCommands,
  ...relevanceCommands,
  ...directoryCommands,
  ...chatCommands,
  ...pipelineCommands,
  ...workflowsCommands,
  ...peopleCommands,
  ...materialCommands,
  ...resumeCommands,
  ...legacyMcpCommands,
]

const byId = new Map<string, AnyCommand>()
for (const def of COMMANDS) {
  if (byId.has(def.id)) throw new Error(`Two commands are called ${def.id}`)
  byId.set(def.id, def)
}

export function getCommand(id: string): AnyCommand | undefined {
  return byId.get(id)
}

export const agentView = () => agentViewOf(COMMANDS)
export const mcpView = () => mcpViewOf(COMMANDS)
export const a2aView = () => a2aViewOf(COMMANDS)
export const workflowView = () => workflowViewOf(COMMANDS)

export { defineCommand, CommandRefusal } from './define'
export type { AnyCommand, CommandContext, CommandDef, Caller, Kind, Egress } from './define'
export { runCommand, refusalResponse } from './run'
export { codeText, untrustedText, untrustedJson } from './text'
export { SessionProof, ExtensionProof, sessionDoor, extensionDoor, routineDoor, ruleDoor, chatDoor, assistantDoor, agentDoor, workflowDoor } from './doors'
export { toolName, mcpToolName } from './views'
