// The Chat loop, as the one adapter runChatTurn takes (turn.ts `agent`). Chat's commands become the loop's tools
// through runCommand under the Chat door, so every limit, refusal and measure of the registry holds. Each thing a
// tool returns becomes a result the answer check reads; the model's final answer is the structured parts of
// answer.ts, or, when a model cannot give that shape, its last words as one part that is checked the same way.

import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { createCelloAgent } from '@/lib/agents/factory'
import type { AgentContext } from '@/lib/agents/context'
import { agentView, chatDoor, CommandRefusal, runCommand, toolName } from '@/lib/commands'
import type { AnyCommand } from '@/lib/commands'
import { isBudgetCapError } from '@/lib/agents/spend-port'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { celloChatModel, type Ran } from '@/lib/models/choice'
import { AnswerSchema, type ModelAnswer, type TurnResult } from './answer'
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
  applications_start: 'Start preparing an application for one stored role by its id. It checks the posting, tailors the resume and waits for the person to approve it. It never sends or submits anything.',
}

export interface ChatAgentDeps {
  db: AdminClient
  userId: string
  keys: DecryptedApiKeys
  isDemo: boolean
  /** What the turn runs on, resolved by the caller from the person's choice and ceiling. */
  ran: Ran
  signal?: AbortSignal
  profileCard?: string
  /** Test seam: replaces the compiled agent. */
  build?: (input: { tools: unknown[] }) => { invoke: (input: unknown, config?: Record<string, unknown>) => Promise<{ messages: BaseMessage[]; structuredResponse?: unknown }> }
}

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

  return async (input) => {
    const ctxFor = () => chatDoor({ userId: deps.userId, typed: input.typed, chat: { chatId: input.chatId, turnId: input.turnId }, signal: deps.signal })
    const defs: AnyCommand[] = agentView()
    const lcTools = defs.map((def) =>
      tool(
        async (args: Record<string, unknown>) => {
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
            if (isBudgetCapError(e)) throw e
            const message = e instanceof CommandRefusal ? e.message : 'That did not work.'
            return JSON.stringify({ error: message, fix: 'Tell the person what could not be done, in one sentence.' })
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
      deadlineAt: Date.now() + 240_000,
    }
    const agent =
      deps.build?.({ tools: lcTools }) ??
      (createCelloAgent({
        kind: 'chat',
        ctx,
        tools: lcTools as never,
        responseFormat: AnswerSchema as never,
        model: celloChatModel(deps.ran, deps.keys),
        profileCard: deps.profileCard,
      }) as unknown as NonNullable<ReturnType<NonNullable<ChatAgentDeps['build']>>>)

    const next: BaseMessage[] = history ? [new HumanMessage(input.feedback ?? '')] : [...(input.screen ? [new HumanMessage(input.screen)] : []), new HumanMessage(input.typed)]
    const out = await agent.invoke({ messages: [...(history ?? []), ...next] }, { signal: deps.signal, recursionLimit: 80 })
    history = out.messages

    const parsed = AnswerSchema.safeParse(out.structuredResponse)
    const last = [...out.messages].reverse().find((m) => m.getType() === 'ai' && textOf(m).trim())
    let answer: ModelAnswer = parsed.success ? parsed.data : { parts: textOf(last).trim() ? [{ about: [], text: textOf(last).trim().slice(0, 4000) }] : [] }
    // A search's roles are shown as cards whether or not the model remembered to list them: the rows are code's.
    if (found.length && !answer.cards?.length) answer = { ...answer, cards: found.slice(0, 12).map((t) => ({ kind: t.kind as 'role', id: t.id })) }

    const made = madeIds.size
      ? (((await deps.db.from('artifacts').select('id, type, title, created_at').eq('user_id', deps.userId).in('id', [...madeIds])).data as { id: string; type: string; title: string; created_at: string }[] | null) ?? [])
      : []
    return { answer, results: results.splice(0), ran: deps.ran, tools, sources, made }
  }
}
