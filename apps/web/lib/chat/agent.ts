// The Chat loop, as the one adapter runChatTurn takes (turn.ts `agent`). Chat's commands become the loop's tools
// through runCommand under the Chat door, so every limit, refusal and measure of the registry holds. Each thing a
// tool returns becomes a result the answer check reads; the model's final answer is the structured parts of
// answer.ts, or, when a model cannot give that shape, its last words as one part that is checked the same way.

import { HumanMessage, isAIMessageChunk, type AIMessageChunk, type BaseMessage, type BaseMessageChunk } from '@langchain/core/messages'
import { MemorySaver } from '@langchain/langgraph'
import { tool } from '@langchain/core/tools'
import { createCelloAgent } from '@/lib/agents/factory'
import { loadUserMcpTools, type UserMcpTool, type UserMcpTools } from '@/lib/agents/user-mcp'
import type { AgentContext } from '@/lib/agents/context'
import { agentView, chatDoor, CommandRefusal, runCommand, toolName } from '@/lib/commands'
import type { AnyCommand } from '@/lib/commands'
import { isBudgetCapError } from '@/lib/agents/spend-port'
import { StoppedError } from './workers'
import { chunkToEvent } from '@/lib/agents/sse'
import { joinWords, liveText } from './live'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { reasonOf } from '@/lib/models/caps'
import { celloChatModel, type Ran, type Role } from '@/lib/models/choice'
import { AnswerSchema, type ModelAnswer, type TurnResult } from './answer'
import { mcpTargets } from './mcp-confirm'
import { propose } from './proposals'
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
  postings_read: 'Read one job posting from a link the person typed in this message. Returns its title, place, pay as stated and its requirements in the posting\'s own words. Stores nothing. A link to a list of roles is refused with what to do instead.',
  applications_start: 'Start preparing an application for one stored role by its id. It checks the posting and tailors the resume. In Ask first it then waits for the person to approve the resume and nothing is sent; in Hands-off, say what its sentence says. Never say you applied, sent or submitted.',
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
  /** Test seam: the person's own tools, loaded each call. Default: their enabled servers (lib/agents/user-mcp.ts). */
  mcp?: () => Promise<UserMcpTools>
  /** Test seam: replaces the compiled agent. */
  build?: (input: { tools: unknown[] }) => {
    invoke: (input: unknown, config?: Record<string, unknown>) => Promise<{ messages: BaseMessage[]; structuredResponse?: unknown }>
    stream?: (input: unknown, config?: Record<string, unknown>) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
  }
}

/** The tool row shown while the model rewrites an answer the check sent back. */
const CHECKING = 'Checking the answer'

const textOf = (m: BaseMessage | undefined): string => (!m ? '' : typeof m.content === 'string' ? m.content : (m.content as { text?: string }[]).map((b) => b.text ?? '').join(''))

const thingsOf = (out: unknown): Thing[] => {
  const t = (out as { things?: unknown } | null)?.things
  return Array.isArray(t) ? (t as Thing[]) : []
}

const NO_MCP: UserMcpTools = { tools: [], entries: [], skipped: [], close: async () => undefined }
const RESULT_MAX = 4000

/** The words of what a server returned: text blocks as they are, any other block as its type. */
const flatten = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map((b) => (typeof b === 'string' ? b : typeof (b as { text?: unknown })?.text === 'string' ? (b as { text: string }).text : `[${(b as { type?: string })?.type ?? 'content'}]`)).join('\n\n') : (JSON.stringify(v) ?? '')

/** Every string under a key that names who or where something goes, at any depth and inside arrays. */
function recipientValues(args: unknown, keys: readonly string[], inside = false): string[] {
  if (typeof args === 'string') return inside ? [args] : []
  if (Array.isArray(args)) return args.flatMap((v) => recipientValues(v, keys, inside))
  if (args && typeof args === 'object') return Object.entries(args).flatMap(([k, v]) => recipientValues(v, keys, inside || keys.includes(k)))
  return []
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
  // What code adds to the answer when the model leaves it out: a Confirm that is waiting, a tool it would not use.
  const waiting: string[] = []
  const declined: string[] = []
  const unreached = new Set<string>()
  const saver = new MemorySaver()

  const turn = async (input: AgentInput, mcp: UserMcpTools): Promise<AgentOutput> => {
    const ctxFor = () => chatDoor({ userId: deps.userId, typed: input.typed, chat: { chatId: input.chatId, turnId: input.turnId }, mode: deps.mode, signal: deps.signal })
    const defs: AnyCommand[] = agentView()
    const lcTools = defs.map((def) =>
      tool(
        async (args: Record<string, unknown>) => {
          if (await deps.stop?.()) throw new StoppedError()
          deps.emit?.({ event: 'custom', data: { type: 'tool', label: def.label, phase: 'start' } })
          try {
            const out = await runCommand(def, ctxFor(), args)
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
            deps.emit?.({ event: 'custom', data: { type: 'tool', label: def.label, phase: 'end' } })
          }
        },
        { name: toolName(def), description: HELP[toolName(def)] ?? def.label, schema: def.input }
      )
    )

    // The person's own tools. A tool marked Never is not here; read tools run, the rest wait for the person's Confirm.
    const outside = mcp.entries
      .filter((e) => (['read', 'confirm'] as string[]).includes(e.tier))
      .map((entry) => {
        const label = `${entry.name} on ${entry.server}`
        return tool(
          async (args: Record<string, unknown>) => {
            if (await deps.stop?.()) throw new StoppedError()
            deps.emit?.({ event: 'custom', data: { type: 'tool', label, phase: 'start' } })
            try {
              if (entry.tier === 'read') {
                tools.push({ label })
                const text = flatten(await entry.tool.invoke(args)).slice(0, RESULT_MAX)
                results.push({ object: null, text })
                return text
              }
              return await waitForConfirm(entry, args)
            } catch (e) {
              if (e instanceof StoppedError || isBudgetCapError(e)) throw e
              const message = 'That did not work.'
              results.push({ object: null, text: message })
              return JSON.stringify({ error: message, fix: 'Tell the person what could not be done, in one sentence.' })
            } finally {
              deps.emit?.({ event: 'custom', data: { type: 'tool', label, phase: 'end' } })
            }
          },
          { name: entry.tool.name, description: entry.tool.description, schema: entry.tool.schema as never }
        )
      })
    // A tool that sends or submits is never called here: its call becomes a card, and the server hears of it on Confirm.
    const waitForConfirm = async (entry: UserMcpTool, args: Record<string, unknown>): Promise<string> => {
      const typed = input.typed.toLowerCase()
      const stray = recipientValues(args, entry.recipients).find((v) => !typed.includes(v.toLowerCase()))
      if (stray !== undefined) {
        const line = `Cello did not use ${entry.name}: ${stray} is not in what you typed.`
        if (!declined.includes(line)) declined.push(line)
        results.push({ object: null, text: line })
        return JSON.stringify({ error: 'That address is not in what the person typed.', fix: 'Ask the person who it goes to.' })
      }
      const made = await propose(deps.db, deps.userId, { chatId: input.chatId, turnId: input.turnId, kind: 'mcp', payload: { server: entry.server, tool: entry.name, args } }, mcpTargets({ chatId: input.chatId, isDemo: deps.isDemo }))
      if (!made.ok) {
        results.push({ object: null, text: made.error })
        return JSON.stringify({ error: made.error, fix: made.fix })
      }
      const sentence = `Waiting for your Confirm: ${made.card}`
      waiting.push(sentence)
      results.push({ object: null, text: sentence })
      return JSON.stringify({ waiting: true, sentence })
    }

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
      deadlineAt: Date.now() + 240_000,
    }
    const agent =
      deps.build?.({ tools: [...lcTools, ...outside] }) ??
      (createCelloAgent({
        kind: 'chat',
        ctx,
        tools: [...lcTools, ...outside] as never,
        responseFormat: AnswerSchema as never,
        model: celloChatModel(deps.ran, deps.keys),
        skillsTier: ({ R2: 'local', R3: 'free', R4: 'paid' } as const)[deps.ran.rung],
        // The Researcher runs on the model the person chose for research, held to the same highest as Chat.
        ...(deps.roles?.researcher ? { researcherModel: celloChatModel(deps.roles.researcher, deps.keys, 'researcher') } : {}),
        profileCard: deps.profileCard,
        saver,
      }) as unknown as NonNullable<ReturnType<NonNullable<ChatAgentDeps['build']>>>)

    const next: BaseMessage[] = history ? [new HumanMessage(input.feedback ?? '')] : [...(input.screen ? [new HumanMessage(input.screen)] : []), new HumanMessage(input.typed)]
    let out: { messages: BaseMessage[]; structuredResponse?: unknown }
    try {
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
          const chunks = await (agent as unknown as { stream: (input: unknown, config?: unknown) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown> }).stream({ messages: [...(history ?? []), ...next] }, { signal: deps.signal, configurable: { thread_id: input.turnId }, recursionLimit: 80, streamMode: ['values', 'messages', 'custom'], subgraphs: true })
          for await (const chunk of chunks) {
            if (!Array.isArray(chunk) || chunk.length < 3) continue
            const [namespace, mode, data] = chunk as [readonly string[], string, unknown]
            if (!retry || mode !== 'messages') deps.emit(chunkToEvent([namespace, mode, data]))
            // The chat loop's own model runs under "model_request:<id>" and its tools under "tools:<id>"; a subagent is a
            // model run nested inside a tool call ("tools:<id>" then "model_request:<id>").
            const delegation = namespace.length >= 2 && namespace[0].startsWith('tools:') ? namespace[0] : null
            const root = !namespace[0]?.startsWith('tools:')
            if (delegation && !delegations.has(delegation)) {
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
        out = await agent.invoke({ messages: [...(history ?? []), ...next] }, { signal: deps.signal, configurable: { thread_id: input.turnId }, recursionLimit: 80 })
      }
    } catch (e) {
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
    // A Confirm that is waiting, and a tool Cello would not use, are said by code: the person must not have to guess.
    const sentences = [...declined.filter((l) => !said.includes(l.toLowerCase())), ...waiting.filter((w) => !said.includes('waiting for your confirm') && !said.includes(w.toLowerCase()))]
    if (sentences.length) answer = { ...answer, parts: [...answer.parts, ...sentences.map((text) => ({ about: [], text }))] }

    const made = madeIds.size
      ? (((await deps.db.from('artifacts').select('id, type, title, created_at').eq('user_id', deps.userId).in('id', [...madeIds])).data as { id: string; type: string; title: string; created_at: string }[] | null) ?? [])
      : []
    return { answer, results: results.splice(0), ran: deps.ran, roles: { chat: deps.ran, ...(deps.roles?.researcher ? { researcher: deps.roles.researcher } : {}) }, tools, sources, made, ...(unreached.size ? { unreached: [...unreached] } : {}) }
  }

  // The person's servers are loaded for each call and closed after it, so a server added now is used on the next turn.
  return async (input) => {
    const mcp = deps.isDemo ? NO_MCP : await (deps.mcp ?? (() => loadUserMcpTools({ admin: deps.db, userId: deps.userId, isDemo: deps.isDemo })))()
    for (const s of mcp.skipped) unreached.add(s.name)
    try {
      return await turn(input, mcp)
    } finally {
      await mcp.close().catch(() => undefined)
    }
  }
}
