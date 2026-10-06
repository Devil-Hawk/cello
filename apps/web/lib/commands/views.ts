// The generated views (blueprint 5.1): what Chat, an MCP host, another agent and
// a workflow may see are filtered from the one registry, never written by hand.
//
// A person-only command (callers are session, extension or both) and anything
// that sends never appears in any view. MCP and A2A never list a command that
// needs typed words or may reach text the person typed: there is no person on
// the other end to have typed them.

import type { AnyCommand, Caller } from './define'

const PERSON_ONLY: Caller[] = ['session', 'extension']

export function isPersonOnly(def: AnyCommand): boolean {
  return def.callers.every((c) => PERSON_ONLY.includes(c))
}

function listedFor(commands: readonly AnyCommand[], caller: Caller, external: boolean): AnyCommand[] {
  return commands.filter((def) => {
    if (!def.callers.includes(caller)) return false
    if (def.sends || isPersonOnly(def)) return false
    if (external && (def.needsTyped || def.egress === 'typed')) return false
    return true
  })
}

/** Chat's tools. */
export const agentViewOf = (commands: readonly AnyCommand[]) => listedFor(commands, 'chat', false)

/** What an MCP host sees: reads, and drafts saved for approval. */
export const mcpViewOf = (commands: readonly AnyCommand[]) => listedFor(commands, 'assistant', true)

/** What another agent sees through the A2A card. */
export const a2aViewOf = (commands: readonly AnyCommand[]) => listedFor(commands, 'agent', true)

/** What a fixed workflow may call. */
export const workflowViewOf = (commands: readonly AnyCommand[]) => listedFor(commands, 'workflow', false)

/** `roles.find` is the tool `roles_find`. */
export function toolName(def: AnyCommand): string {
  return def.id.replace(/\./g, '_')
}

/** MCP keeps the 18 tools hosts already use under their old names (Q6). */
export const LEGACY_PREFIX = 'legacy.'

export function mcpToolName(def: AnyCommand): string {
  return def.id.startsWith(LEGACY_PREFIX) ? def.id.slice(LEGACY_PREFIX.length) : toolName(def)
}
