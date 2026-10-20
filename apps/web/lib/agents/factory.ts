// createCelloAgent: the one place an agent is built.
//
// Every agent loop, the orchestrator and the Researcher, comes from this file, so none
// can exist without the guard stack (lib/agents/middleware.ts), the one chat model door
// (lib/agents/model.ts) and the checkpointer. lib/agents/chokepoints.test.ts
// fails the build when `createDeepAgent(`, `createSubAgent(` or `createAgent(` appears
// anywhere else. `createAgent` (langchain) is used here only for the plain chat core: the
// same prompt, guards and answer shape without Deep Agents' delegation, todo list or files.
//
// Deep Agents does not hand custom middleware to an isolated subagent, so the Researcher's
// guard stack is attached here, to its own spec, not inherited. Subagents never get the
// task tool (Deep Agents gives it to the top agent only), so delegation is one level deep,
// and the factory test checks that.

import { createAgent } from 'langchain'
import { createDeepAgent, createSubAgent, type AnySubAgent, type CreateDeepAgentParams, type SubAgent } from 'deepagents'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { composeSystemPrompt, loadModeDoc } from '@/lib/harness/prompts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PERMISSIONS, SKILLS_OFF, celloBackend } from './backends'
import type { AgentContext } from './context'
import type { WorkerScope } from '@/lib/chat/workers'
import { toolStrategy } from 'langchain'
import { guardStack, type AnswerShape, type GuardStackOptions } from './middleware'
import { celloChatModel } from './model'
import { RESEARCHER_DESCRIPTION } from './subagents/researcher'
import { scoutSubAgent } from './subagents/scout'
import { writerSubAgent } from '@/lib/workflows/writer'
import { toAgentTools } from './tools/langchain'
import { researchPrimitives } from './tools/research-tools'
import { RESEARCHER_TOOL_NAMES } from './tools/registry'

/** Skills the Researcher is given by code, not by its own choice. */
export const RESEARCHER_SKILLS = ['company-research', 'visa-sponsorship'] as const

// The trigger bar measures the orchestrator's choice; the Researcher gets its skills by code, so only a skill
// that missed its output checks is taken from it.
const OFF_FOR_RESEARCHER = Object.keys(SKILLS_OFF).filter((k) => SKILLS_OFF[k].includes('checks'))

function skillBodies(names: readonly string[], skillsDir: string, hidden: readonly string[]): string {
  const parts: string[] = []
  for (const name of names) {
    if (hidden.includes(name)) continue
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

/** The chat loop's engine: Deep Agents (what ships) or a plain tool loop (what the evals compare it with). */
export type ChatCore = 'deep' | 'plain'

export interface CelloAgentInput {
  ctx: AgentContext
  /** The checkpointer. Left out for a one-off run that needs no saved state. */
  saver?: BaseCheckpointSaver
  /** Test seams. */
  model?: BaseChatModel
  /** The Researcher's own model, built from the person's choice for it (lib/models/choice.ts). Without one it runs on `model`, the turn's resolved choice, so no subagent is ever on a model the person did not allow. */
  researcherModel?: BaseChatModel
  fallbacks?: GuardStackOptions['fallbacks']
  skillsDir?: string
  /** A test and eval seam: replaces the skills that are switched off, so an eval can still measure one. */
  hiddenSkills?: readonly string[]
  /** Tools from the person's own MCP servers, already checked and prefixed. */
  extraTools?: StructuredToolInterface[]
  /** A short card about the person, appended to the system prompt. Stable across a conversation. */
  profileCard?: string
  /** Chat only: each delegation to the Researcher (the `task` tool) is a worker row with its own Stop. */
  taskRows?: WorkerScope
}

/**
 * The final answer's format. A bad answer is asked for again by CelloOneAnswer (middleware.ts); langchain's own
 * retry for the tool-call format is turned off, because it breaks the after-model nodes (see CelloOneAnswer).
 * A model that answers in the provider's own JSON mode keeps the plain schema, which has no such retry.
 */
function answerFormat(model: BaseChatModel, format: unknown): never {
  const native = (model as { profile?: { structuredOutput?: boolean } }).profile?.structuredOutput === true
  const isZod = typeof (format as { safeParse?: unknown } | undefined)?.safeParse === 'function'
  return (format && isZod && !native ? toolStrategy(format as never, { handleError: false }) : format) as never
}

function guards(input: CelloAgentInput, agent: 'orchestrator' | 'researcher', answer?: AnswerShape, taskRows?: WorkerScope) {
  const { ctx } = input
  const stop = ctx.stop ?? (() => Promise.resolve(false))
  return guardStack({
    ctx: { admin: ctx.admin, userId: ctx.userId, apiKeys: ctx.apiKeys, isDemo: ctx.isDemo, traceId: ctx.traceId, chatTurnId: ctx.chatTurnId, role: agent === 'researcher' ? 'researcher' : 'chat', stop },
    agent,
    deadlineAt: ctx.deadlineAt,
    stop,
    answer,
    fallbacks: input.fallbacks,
    taskRows,
  })
}

/** The Researcher as a declarative spec: its own prompt, model, read-only tools, guard stack and permissions. */
export function researcherSpec(input: CelloAgentInput, name: string = 'researcher'): SubAgent {
  const { ctx } = input
  const skillsDir = input.skillsDir ?? path.join(process.cwd(), 'skills')
  return {
    name,
    description: RESEARCHER_DESCRIPTION,
    systemPrompt: composeSystemPrompt({ mode: loadModeDoc('researcher'), stableContext: skillBodies(RESEARCHER_SKILLS, skillsDir, input.hiddenSkills ?? OFF_FOR_RESEARCHER) }),
    model: input.researcherModel ?? input.model ?? celloChatModel({ apiKeys: ctx.apiKeys, purpose: 'researcher' }),
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
  return [scoutSubAgent(deps), writerSubAgent(deps), researcherSpec(input, 'general-purpose')]
}

/** The orchestrator: the only agent the person talks to. */
export function createCelloAgent(input: CelloAgentInput & { kind: 'orchestrator' }): ReturnType<typeof createDeepAgent>
/** The Researcher as a loop of its own, for a deep research call. Not a task-tool agent: it has no delegation at all. */
export function createCelloAgent(input: CelloAgentInput & { kind: 'researcher' }): ReturnType<typeof createSubAgent>
/** Chat's loop: Chat's commands as tools, the Researcher, and a final answer in the shape lib/chat/answer.ts checks. */
export function createCelloAgent(input: CelloAgentInput & { kind: 'chat'; tools: StructuredToolInterface[]; responseFormat: CreateDeepAgentParams['responseFormat']; core?: ChatCore }): ReturnType<typeof createDeepAgent>
export function createCelloAgent(input: CelloAgentInput & { kind: 'orchestrator' | 'researcher' | 'chat'; tools?: StructuredToolInterface[]; responseFormat?: unknown; core?: ChatCore }) {
  const { ctx } = input
  if (input.kind === 'researcher') return createSubAgent(researcherSpec(input, 'researcher'))
  if (input.kind === 'chat') {
    const model = input.model ?? celloChatModel({ apiKeys: ctx.apiKeys, purpose: 'orchestrator', serverFallback: !ctx.isDemo })
    const answer = input.responseFormat as (AnswerShape & object) | undefined
    if (input.core === 'plain') {
      return createAgent({
        name: 'cello-chat',
        model,
        tools: input.tools ?? [],
        systemPrompt: composeSystemPrompt({ mode: loadModeDoc('chat'), stableContext: input.profileCard }),
        middleware: guards(input, 'orchestrator', typeof answer?.safeParse === 'function' ? answer : undefined),
        responseFormat: answerFormat(model, input.responseFormat) as never,
        checkpointer: input.saver,
      }) as never
    }
    return createDeepAgent({
      name: 'cello-chat',
      model,
      systemPrompt: composeSystemPrompt({ mode: loadModeDoc('chat'), stableContext: input.profileCard }),
      tools: (input.tools ?? []) as never,
      subagents: [researcherSpec(input, 'general-purpose')],
      backend: celloBackend({ admin: ctx.admin, userId: ctx.userId, skillsDir: input.skillsDir, hiddenSkills: input.hiddenSkills }),
      permissions: PERMISSIONS.orchestrator,
      middleware: guards(input, 'orchestrator', typeof answer?.safeParse === 'function' ? answer : undefined, input.taskRows),
      checkpointer: input.saver,
      responseFormat: answerFormat(model, input.responseFormat),
    })
  }

  const skillsDir = input.skillsDir
  return createDeepAgent({
    name: 'cello',
    model: input.model ?? celloChatModel({ apiKeys: ctx.apiKeys, purpose: 'orchestrator', serverFallback: !ctx.isDemo }),
    systemPrompt: composeSystemPrompt({ mode: loadModeDoc('orchestrator'), stableContext: input.profileCard }),
    tools: [...toAgentTools(ctx), ...(input.extraTools ?? [])] as never,
    subagents: specialists(input),
    skills: ['/skills/'],
    backend: celloBackend({ admin: ctx.admin, userId: ctx.userId, skillsDir, hiddenSkills: input.hiddenSkills }),
    permissions: PERMISSIONS.orchestrator,
    middleware: guards(input, 'orchestrator'),
    checkpointer: input.saver,
  })
}
