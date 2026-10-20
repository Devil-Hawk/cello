// The Chat loop, as the one adapter runChatTurn takes (turn.ts `agent`). Chat's commands become the loop's tools
// through runCommand under the Chat door, so every limit, refusal and measure of the registry holds. Each thing a
// tool returns becomes a result the answer check reads; the model's final answer is the structured parts of
// answer.ts, or, when a model cannot give that shape, its last words as one part that is checked the same way.

import { HumanMessage, isAIMessageChunk, type AIMessageChunk, type BaseMessage, type BaseMessageChunk } from '@langchain/core/messages'
import { Command, MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph'
import { tool } from '@langchain/core/tools'
import { createCelloAgent } from '@/lib/agents/factory'
import type { AgentContext } from '@/lib/agents/context'
import { agentView, chatDoor, CommandRefusal, runCommand, toolName } from '@/lib/commands'
import type { AnyCommand } from '@/lib/commands'
import { isBudgetCapError } from '@/lib/agents/spend-port'
import { MovedError, StoppedError } from './workers'
import { chunkToEvent } from '@/lib/agents/sse'
import { joinWords, liveText } from './live'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { reasonOf } from '@/lib/models/caps'
import { celloChatModel, type Ran, type Role } from '@/lib/models/choice'
import { AnswerSchema, type ModelAnswer, type TurnResult } from './answer'
import type { Mode } from './mode'
import type { AgentInput, AgentOutput } from './turn'
import { resultOf } from './recalled'
import type { Thing } from './things'

/** What each tool is for, in the model's terms. A command with no entry here is described by its label. */
const HELP: Record<string, string> = {
  roles_find: 'Find roles among the ones the person has stored. Filters: type (a role type such as Forward Deployed Engineer or FDE), place (such as San Francisco or SF), words, interested (only the ones they marked Interested), limit (how many). Returns the roles and one sentence saying what was searched.',
  roles_get: 'Read one stored role by its id: title, company, place, pay as stated, chance, posted date, what the person covers and lacks.',
  companies_get: 'Read one company by its id: the open roles stored, the applications, whether the person follows it.',
  roles_compare: 'Compare 2 to 12 stored roles by their ids. Saves a comparison table that opens beside the chat. Use it for "compare", "which of these".',
  people_find: 'Find one of the person\'s contacts by name. Returns the contact with their company and their latest message to the person. Use it before a reply, to get the contact id.',
  chat_recall: 'Look in the person\'s earlier chats by words. Returns what they said, made or decided there, with the chat it came from.',
  documents_draft: 'Write one draft with the Writer: type reply (to a person, pass contact_id), message, follow_up, note, cover_letter or resume (pass job_id for a role). Saves it as a draft. Never sends.',
  applications_start: 'Start preparing applications for stored roles: job_id for one, or job_ids for up to 3 the person named or attached, in one call. It checks each posting and tailors the resume. In Ask first it then waits for the person to approve the resume and nothing is sent; in Hands-off, say what its sentence says. Never say you applied, sent or submitted.',
}

export interface ChatAgentDeps {
  db: AdminClient
  userId: string
  keys: DecryptedApiKeys
  isDemo: boolean
  /** What the turn runs on, resolved by the caller from the person's choice and ceiling. */
  ran: Ran
  /** What each role runs on this turn (the person's choice for it, or Chat's), from lib/chat/settings.ts. */
  roles?: Partial<Record<Role, Ran | null>>
  /** The turn's mode, resolved by code in run.ts; the door carries it to each command. */
  mode?: Mode
  signal?: AbortSignal
  stop?: () => Promise<boolean>
  emit?: (event: { event: string; data: unknown }) => void
  profileCard?: string
  /** The checkpointer of the turn, opened by run.ts and closed there. Without one a MemorySaver keeps the turn in memory. */
  saver?: BaseCheckpointSaver
  /** The first call of this closure carries on the checkpoint of thread `turnId` instead of starting the turn. */
  resume?: boolean
  /** Test seam: replaces the compiled agent. */
  build?: (input: { tools: unknown[] }) => {
    invoke: (input: unknown, config?: Record<string, unknown>) => Promise<{ messages: BaseMessage[]; structuredResponse?: unknown }>
    stream?: (input: unknown, config?: Record<string, unknown>) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
    getState?: (config: Record<string, unknown>) => Promise<{ next: readonly string[]; tasks?: { interrupts?: { value?: unknown }[] }[]; values?: { messages?: BaseMessage[] } }>
  }
}

/** How long one request may run a turn before it hands over to the worker. */
export const chatSliceMs = (): number => Number(process.env.CHAT_SLICE_MS) || 240_000

/** The tool row shown while the model rewrites an answer the check sent back. */
const CHECKING = 'Checking the answer'

const textOf = (m: BaseMessage | undefined): string => (!m ? '' : typeof m.content === 'string' ? m.content : (m.content as { text?: string }[]).map((b) => b.text ?? '').join(''))

const thingsOf = (out: unknown): Thing[] => {
  const t = (out as { things?: unknown } | null)?.things
  return Array.isArray(t) ? (t as Thing[]) : []
}

/** The loop for one person, as the function runChatTurn calls once for the answer and once more for a failed part. */
export function chatAgent(deps: ChatAgentDeps): (input: AgentInput) => Promise<AgentOutput> {
  // One conversation with the model per turn: a retry continues it, so the tools are not called again for nothing.
  let history: BaseMessage[] | null = null
  const tools: NonNullable<AgentOutput['tools']> = []
  const sources: NonNullable<AgentOutput['sources']> = []
  const results: TurnResult[] = []
  const found: Thing[] = []
  const madeIds = new Set<string>()
  // A cap, a missing key or a refusal a tool met this turn, in code's words, so the person reads it even when the model leaves it out.
  const refusals: string[] = []
  // What a tool returned becomes evidence for the answer check, a source under the answer and a card to show. One place, so a
  // slice that carries on a turn can read it back from the checkpoint's tool messages instead of losing the first slice's.
  const record = (def: AnyCommand, out: unknown) => {
    const things = thingsOf(out)
    tools.push({ label: def.label })
    for (const t of things) {
      results.push(resultOf(t))
      if (t.kind === 'made') madeIds.add(t.id)
      else if (!t.recalled) sources.push({ title: t.title, host: t.company ?? 'Your stored roles' })
      if (def.id === 'roles.find') found.push(t)
    }
    // The sentence is code's own: it also stands as evidence for a part about nothing in particular.
    const sentence = (out as { sentence?: string } | null)?.sentence
    if (sentence) results.push({ object: null, text: sentence })
  }
  const saver = deps.saver ?? new MemorySaver()
  // One deadline for the whole turn, not one for each call: a retry does not get a fresh slice.
  const deadlineAt = Date.now() + chatSliceMs()
  let resuming = Boolean(deps.resume)
  // Commands running now. A command that fans out (several applications at once) runs nested graphs under its own tool
  // namespace; those are not the Researcher, so they are never shown as one.
  let commandsRunning = 0

  return async (input) => {
    const ctxFor = () => chatDoor({ userId: deps.userId, typed: input.typed, chat: { chatId: input.chatId, turnId: input.turnId }, mode: deps.mode, signal: deps.signal })
    const defs: AnyCommand[] = agentView()
    const lcTools = defs.map((def) =>
      tool(
        async (args: Record<string, unknown>, config?: { toolCall?: { id?: string } }) => {
          if (await deps.stop?.()) throw new StoppedError()
          deps.emit?.({ event: 'custom', data: { type: 'tool', label: def.label, phase: 'start' } })
          commandsRunning++
          try {
            const callId = config?.toolCall?.id
            const out = await runCommand(def, { ...ctxFor(), callKey: callId ? `${input.turnId}:${callId}`.slice(0, 160) : undefined }, args)
            record(def, out)
            return JSON.stringify(out)
          } catch (e) {
            if (e instanceof StoppedError || isBudgetCapError(e)) throw e
            const reason = reasonOf(e, 'chat')
            const message = reason ?? 'That did not work.'
            // Code's own line: evidence for what the model says about it, so the check keeps that part.
            results.push({ object: null, text: message })
            if (reason && !refusals.includes(reason)) refusals.push(reason)
            return JSON.stringify({ error: message, fix: 'Tell the person what could not be done, in one sentence.' })
          } finally {
            commandsRunning--
            deps.emit?.({ event: 'custom', data: { type: 'tool', label: def.label, phase: 'end' } })
          }
        },
        { name: toolName(def), description: HELP[toolName(def)] ?? def.label, schema: def.input }
      )
    )

    const ctx: AgentContext = {
      admin: deps.db,
      userId: deps.userId,
      userEmail: '',
      apiKeys: deps.keys,
      isDemo: deps.isDemo,
      threadId: input.chatId,
      conversationId: null,
      autonomy: 'ask',
      traceId: '',
      chatTurnId: input.turnId,
      signal: deps.signal,
      stop: deps.stop,
      deadlineAt,
    }
    const agent =
      deps.build?.({ tools: lcTools }) ??
      (createCelloAgent({
        kind: 'chat',
        ctx,
        tools: lcTools as never,
        responseFormat: AnswerSchema as never,
        model: celloChatModel(deps.ran, deps.keys),
        // The Researcher runs on the model the person chose for research, held to the same highest as Chat.
        ...(deps.roles?.researcher ? { researcherModel: celloChatModel(deps.roles.researcher, deps.keys, 'researcher') } : {}),
        profileCard: deps.profileCard,
        saver,
        taskRows: { db: deps.db, userId: deps.userId, threadId: input.chatId, chatId: input.chatId, turnId: input.turnId, model: deps.ran.model, rung: deps.ran.rung },
      }) as unknown as NonNullable<ReturnType<NonNullable<ChatAgentDeps['build']>>>)

    const next: BaseMessage[] = history ? [new HumanMessage(input.feedback ?? '')] : [...(input.screen ? [new HumanMessage(input.screen)] : []), new HumanMessage(input.typed)]
    let out: { messages: BaseMessage[]; structuredResponse?: unknown }
    // One checkpoint thread for each turn; 'sync' saves it before the next step, so a request that dies loses nothing.
    const thread = { configurable: { thread_id: input.turnId } }
    const config = { signal: deps.signal, ...thread, durability: 'sync', recursionLimit: 80 }
    const getState = (agent as { getState?: NonNullable<ReturnType<NonNullable<ChatAgentDeps['build']>>['getState']> }).getState?.bind(agent)
    try {
      // The first call of a resumed turn carries on its checkpoint: a held interrupt is answered, a pending step is replayed.
      let first: unknown = { messages: [...(history ?? []), ...next] }
      if (resuming) {
        resuming = false
        const state = await getState?.(thread)
        if (state && state.next.length > 0) first = state.tasks?.some((t) => t.interrupts?.length) ? new Command({ resume: 'continue' }) : null
        // What the earlier slices' tools returned is in the checkpoint: read it back, so the answer is checked against all of it.
        for (const m of state?.values?.messages ?? []) {
          if (m.getType() !== 'tool') continue
          const def = defs.find((d) => toolName(d) === (m as { name?: string }).name)
          let out: unknown = null
          try {
            out = JSON.parse(textOf(m))
          } catch {
            continue
          }
          if (!def) continue
          const failed = (out as { error?: unknown } | null)?.error
          if (typeof failed === 'string') {
            results.push({ object: null, text: failed })
            if (failed !== 'That did not work.' && !refusals.includes(failed)) refusals.push(failed)
          }
          else record(def, out)
        }
      }
      const stream = (agent as unknown as { stream?: (input: unknown, config?: unknown) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown> }).stream
      if (deps.emit && stream) {
        let values: { messages?: BaseMessage[]; structuredResponse?: unknown } | null = null
        // The root model's answer so far: chunks concatenated as LangChain does, so a structured answer written as a
        // tool call accumulates its partial arguments and liveText reads the parts written so far.
        let written: AIMessageChunk | null = null
        // The words of the earlier root messages of this call: the box only grows, a tool running never empties it.
        let settled = ''
        // The check's retry (the model has already answered once) streams no words: the box keeps what the person saw.
        const retry = history !== null
        let lastWords = ''
        let lastWordsAt = 0
        const sendWords = (force: boolean) => {
          const words = joinWords(settled, liveText(written))
          if (retry || !words || words === lastWords || (!force && Date.now() - lastWordsAt < 150)) return
          lastWords = words
          lastWordsAt = Date.now()
          deps.emit?.({ event: 'custom', data: { type: 'words', text: words } })
        }
        // A delegation to the Researcher runs under a "tools:<call id>" namespace: it is shown as a tool row while it runs.
        const delegations = new Set<string>()
        if (retry) deps.emit({ event: 'custom', data: { type: 'tool', label: CHECKING, phase: 'start' } })
        try {
          const chunks = await (agent as unknown as { stream: (input: unknown, config?: unknown) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown> }).stream(first, { ...config, streamMode: ['values', 'messages', 'custom'], subgraphs: true })
          for await (const chunk of chunks) {
            if (!Array.isArray(chunk) || chunk.length < 3) continue
            const [namespace, mode, data] = chunk as [readonly string[], string, unknown]
            if (!retry || mode !== 'messages') deps.emit(chunkToEvent([namespace, mode, data]))
            // The chat loop's own model runs under "model_request:<id>" and its tools under "tools:<id>"; a subagent is a
            // model run nested inside a tool call ("tools:<id>" then "model_request:<id>").
            const delegation = namespace.length >= 2 && namespace[0].startsWith('tools:') ? namespace[0] : null
            const root = !namespace[0]?.startsWith('tools:')
            if (delegation && commandsRunning === 0 && !delegations.has(delegation)) {
              delegations.add(delegation)
              deps.emit({ event: 'custom', data: { type: 'tool', label: 'Research', phase: 'start' } })
            }
            if (root && delegations.size && mode === 'values') {
              delegations.clear()
              deps.emit({ event: 'custom', data: { type: 'tool', label: 'Research', phase: 'end' } })
            }
            if (namespace.length === 0 && mode === 'values' && data && typeof data === 'object') values = data as { messages?: BaseMessage[]; structuredResponse?: unknown }
            if (root && mode === 'messages' && Array.isArray(data) && isAIMessageChunk(data[0] as BaseMessageChunk)) {
              const piece = data[0] as AIMessageChunk
              // langchain's AgentNode appends its own "Returning structured response: {...}" message after a structured
              // answer; it is the loop's bookkeeping, not words the model wrote.
              if (typeof piece.content === 'string' && piece.content.startsWith('Returning structured response:')) continue
              // A tool result or a new model turn starts a new message: the id changes, and the words so far are kept.
              if (written && piece.id && piece.id !== written.id) settled = joinWords(settled, liveText(written))
              written = written && (!piece.id || piece.id === written.id) ? written.concat(piece) : piece
              sendWords(false)
            }
          }
          sendWords(true)
        } finally {
          if (retry) deps.emit({ event: 'custom', data: { type: 'tool', label: CHECKING, phase: 'end' } })
        }
        out = { messages: values?.messages ?? [], structuredResponse: values?.structuredResponse }
      } else {
        out = await agent.invoke(first as never, config)
      }
      // The graph stopped before its end (the slice deadline): the checkpoint is saved and another request carries on.
      const end = await getState?.(thread)
      if (end && end.next.length > 0) throw new MovedError()
    } catch (e) {
      if (e instanceof MovedError || e instanceof StoppedError) throw e
      // The loop itself died after a tool was refused: the refusal is the reason the person reads, not "try again".
      if (refusals.length && !reasonOf(e) && !deps.signal?.aborted) throw new CommandRefusal(502, refusals.join(' '), 'failed')
      throw e
    }
    history = out.messages

    const parsed = AnswerSchema.safeParse(out.structuredResponse)
    const last = [...out.messages].reverse().find((m) => m.getType() === 'ai' && textOf(m).trim())
    let answer: ModelAnswer = parsed.success ? parsed.data : { parts: textOf(last).trim() ? [{ about: [], text: textOf(last).trim().slice(0, 4000) }] : [] }
    // A search's roles are shown as cards whether or not the model remembered to list them: the rows are code's.
    if (found.length && !answer.cards?.length) answer = { ...answer, cards: found.slice(0, 12).map((t) => ({ kind: t.kind as 'role', id: t.id })) }
    // The real reason a tool refused is said by code when the model's parts do not carry it (acceptance H2).
    const said = answer.parts.map((p) => p.text.toLowerCase()).join('\n')
    const unsaid = refusals.filter((r) => !said.includes(r.toLowerCase()))
    if (unsaid.length) answer = { ...answer, parts: [...answer.parts, ...unsaid.map((text) => ({ about: [], text }))] }

    const made = madeIds.size
      ? (((await deps.db.from('artifacts').select('id, type, title, created_at').eq('user_id', deps.userId).in('id', [...madeIds])).data as { id: string; type: string; title: string; created_at: string }[] | null) ?? [])
      : []
    return { answer, results: results.splice(0), ran: deps.ran, roles: { chat: deps.ran, ...(deps.roles?.researcher ? { researcher: deps.roles.researcher } : {}) }, tools, sources, made }
  }
}
