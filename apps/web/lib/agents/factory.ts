// createCelloAgent: the one place an agent is built.
//
// Every agent loop, the orchestrator and the Researcher, comes from this file, so none
// can exist without the guard stack (lib/agents/middleware.ts), the one chat model door
// (lib/agents/model.ts) and the checkpointer. lib/agents/chokepoints.test.ts
// fails the build when `createDeepAgent(`, `createSubAgent(` or `createAgent(` appears
// anywhere else.
//
// Deep Agents does not hand custom middleware to an isolated subagent, so the Researcher's
// guard stack is attached here, to its own spec, not inherited. Subagents never get the
// task tool (Deep Agents gives it to the top agent only), so delegation is one level deep,
// and the factory test checks that.

import { createDeepAgent, createSubAgent, type AnySubAgent, type SubAgent } from 'deepagents'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { composeSystemPrompt, loadModeDoc } from '@/lib/harness/prompts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PERMISSIONS, celloBackend } from './backends'
import type { AgentContext } from './context'
import { guardStack, type GuardStackOptions } from './middleware'
import { celloChatModel } from './model'
import { RESEARCHER_DESCRIPTION } from './subagents/researcher'
import { scoutSubAgent } from './subagents/scout'
import { writerSubAgent } from './subagents/writer'
import { toAgentTools } from './tools/langchain'
import { researchPrimitives } from './tools/research-tools'
import { RESEARCHER_TOOL_NAMES } from './tools/registry'

/** Skills the Researcher is given by code, not by its own choice. */
export const RESEARCHER_SKILLS = ['company-research', 'visa-sponsorship'] as const

function skillBodies(names: readonly string[], skillsDir: string): string {
  const parts: string[] = []
  for (const name of names) {
    try {
      const text = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8')
      // The body after the frontmatter: the procedure the specialist follows.
      parts.push(text.replace(/^---[\s\S]*?---\s*/, '').trim())
    } catch {
      // A missing skill file must not stop research; the base prompt still holds the rules.
    }
  }
  return parts.length ? `SKILLS YOU FOLLOW:\n\n${parts.join('\n\n---\n\n')}` : ''
}

export interface CelloAgentInput {
  ctx: AgentContext
  /** The checkpointer. Left out for a one-off run that needs no saved state. */
  saver?: BaseCheckpointSaver
  /** Test seams. */
  model?: BaseChatModel
  /** The model the Researcher gets when it is reached through the orchestrator. */
  researcherModel?: BaseChatModel
  fallbacks?: GuardStackOptions['fallbacks']
  skillsDir?: string
  /** Tools from the person's own MCP servers, already checked and prefixed. */
  extraTools?: StructuredToolInterface[]
  /** A short card about the person, appended to the system prompt. Stable across a conversation. */
  profileCard?: string
}

function guards(input: CelloAgentInput, agent: 'orchestrator' | 'researcher') {
  const { ctx } = input
  return guardStack({
    ctx: { admin: ctx.admin, userId: ctx.userId, apiKeys: ctx.apiKeys, isDemo: ctx.isDemo, traceId: ctx.traceId },
    agent,
    deadlineAt: ctx.deadlineAt,
    fallbacks: input.fallbacks,
  })
}

/** The Researcher as a declarative spec: its own prompt, model, read-only tools, guard stack and permissions. */
export function researcherSpec(input: CelloAgentInput, name: string = 'researcher', standalone = true): SubAgent {
  const { ctx } = input
  const skillsDir = input.skillsDir ?? path.join(process.cwd(), 'skills')
  return {
    name,
    description: RESEARCHER_DESCRIPTION,
    systemPrompt: composeSystemPrompt({ mode: loadModeDoc('researcher'), stableContext: skillBodies(RESEARCHER_SKILLS, skillsDir) }),
    model: input.researcherModel ?? (standalone ? input.model : undefined) ?? celloChatModel({ apiKeys: ctx.apiKeys, purpose: 'researcher' }),
    tools: [...researchPrimitives(ctx), ...toAgentTools({ ...ctx, readOnly: true }, { names: RESEARCHER_TOOL_NAMES })] as never,
    middleware: guards(input, 'researcher'),
    permissions: PERMISSIONS.researcher,
  }
}

/**
 * The specialists the orchestrator can delegate to. Scout and Writer are compiled
 * graphs (fixed workflows with model calls inside); the Researcher is a loop. The Researcher
 * is registered under the reserved name "general-purpose", which stops Deep Agents adding
 * its own general-purpose agent holding every tool. Agent labels the person sees come from
 * our own task rows, not from this name.
 */
export function specialists(input: CelloAgentInput): AnySubAgent[] {
  const deps = { ctx: input.ctx }
  return [scoutSubAgent(deps), writerSubAgent(deps), researcherSpec(input, 'general-purpose', false)]
}

/** The orchestrator: the only agent the person talks to. */
export function createCelloAgent(input: CelloAgentInput & { kind: 'orchestrator' }): ReturnType<typeof createDeepAgent>
/** The Researcher as a loop of its own, for a deep research call. Not a task-tool agent: it has no delegation at all. */
export function createCelloAgent(input: CelloAgentInput & { kind: 'researcher' }): ReturnType<typeof createSubAgent>
export function createCelloAgent(input: CelloAgentInput & { kind: 'orchestrator' | 'researcher' }) {
  const { ctx } = input
  if (input.kind === 'researcher') return createSubAgent(researcherSpec(input, 'researcher', true))

  const skillsDir = input.skillsDir
  return createDeepAgent({
    name: 'cello',
    model: input.model ?? celloChatModel({ apiKeys: ctx.apiKeys, purpose: 'orchestrator', serverFallback: !ctx.isDemo }),
    systemPrompt: composeSystemPrompt({ mode: loadModeDoc('orchestrator'), stableContext: input.profileCard }),
    tools: [...toAgentTools(ctx), ...(input.extraTools ?? [])] as never,
    subagents: specialists(input),
    skills: ['/skills/'],
    backend: celloBackend({ admin: ctx.admin, userId: ctx.userId, skillsDir }),
    permissions: PERMISSIONS.orchestrator,
    middleware: guards(input, 'orchestrator'),
    checkpointer: input.saver,
  })
}
