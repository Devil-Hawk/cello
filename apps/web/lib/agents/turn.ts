// Starting a turn for a person who is typing: everything the stream route does before the
// first byte. The body comes from the useStream hook's transport, so its shape is the hook's:
// `input.messages` for new words, `command.resume` for an answer, and `context.conversationId`
// for the conversation (a new one when absent).
//
// Failures before streaming are plain JSON with a status the UI can act on; each carries one
// sentence from copy.ts. Once this returns ok, the lease is held, and executeTurn releases it.

import { z } from 'zod'
import { DemoThreadExpiredError, ThreadOwnershipError } from '@/lib/graph/invoke'
import { DemoAccessError } from '@/lib/access/guardrails'
import { loadApiKeys } from '@/lib/harness/keys'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { createConversation, getConversation, titleFromMessage } from '@/lib/harness/copilot-store'
import type { AdminClient } from '@/lib/harness/types'
import { newDeadline, type AgentContext } from './context'
import { AGENT_COPY } from './copy'
import type { TurnMode } from './run'
import { claimLease, ensureThread, OldConversationError, type Lease } from './scheduler'

export const StreamBodySchema = z
  .object({
    input: z.object({ messages: z.array(z.object({ content: z.unknown() }).passthrough()).min(1).max(20) }).passthrough().optional(),
    command: z.object({ resume: z.unknown().optional() }).passthrough().optional(),
    context: z.object({ conversationId: z.string().uuid().optional() }).passthrough().nullish(),
  })
  .passthrough()

export type StreamBody = z.infer<typeof StreamBodySchema>

/** The words of a message, whether the hook sent a string or content blocks. */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'string' ? b : (b as { type?: string; text?: unknown })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .join('')
}

export type Refusal = { ok: false; status: number; error: string; message: string }

export type OpenedTurn = { ok: true; ctx: AgentContext; lease: Lease; mode: TurnMode } | Refusal

const refuse = (status: number, error: string, message: string): Refusal => ({ ok: false, status, error, message })

export interface OpenTurnInput {
  admin: AdminClient
  user: { id: string; email?: string | null }
  body: StreamBody
  signal?: AbortSignal
  /** Test seam. */
  loadKeys?: typeof loadApiKeys
}

export async function openUserTurn(input: OpenTurnInput): Promise<OpenedTurn> {
  const { admin, user, body } = input

  const text = textOfContent([...(body.input?.messages ?? [])].reverse().find((m) => m.type === undefined || m.type === 'human')?.content).trim()
  const hasResume = body.command !== undefined && body.command.resume !== undefined
  if (!hasResume && !text) return refuse(400, 'empty', 'Write a message to send.')
  const mode: TurnMode = hasResume ? { kind: 'resume', value: body.command!.resume } : { kind: 'input', text }

  let apiKeys
  try {
    apiKeys = await (input.loadKeys ?? loadApiKeys)(admin, user.id)
  } catch (e) {
    if (e instanceof DemoAccessError) return refuse(403, 'demo_expired', AGENT_COPY.demoExpired)
    throw e
  }
  if (!canRunLlm(apiKeys)) return refuse(402, 'needs_key', AGENT_COPY.needsKey)

  const conversationId = body.context?.conversationId
  if (hasResume && !conversationId) return refuse(400, 'empty', AGENT_COPY.notFound)

  let conversation
  try {
    conversation = conversationId
      ? await getConversation(admin, user.id, conversationId)
      : await createConversation(admin, user.id, { title: titleFromMessage(text) })
  } catch {
    return refuse(500, 'failed', AGENT_COPY.generic)
  }
  if (!conversation) return refuse(404, 'not_found', AGENT_COPY.notFound)

  let thread
  try {
    thread = await ensureThread(
      admin,
      user.id,
      conversation.thread_id ? { surface: 'agent', threadId: conversation.thread_id } : { surface: 'agent', conversationId: conversation.id }
    )
  } catch (e) {
    if (e instanceof OldConversationError) return refuse(409, 'old_conversation', AGENT_COPY.oldConversation)
    if (e instanceof ThreadOwnershipError) return refuse(404, 'not_found', AGENT_COPY.notFound)
    if (e instanceof DemoThreadExpiredError) return refuse(403, 'demo_expired', AGENT_COPY.demoExpired)
    return refuse(500, 'failed', AGENT_COPY.generic)
  }
  if (!conversation.thread_id) {
    await admin.from('copilot_conversations').update({ thread_id: thread.thread_id }).eq('id', conversation.id).eq('user_id', user.id)
  }

  const lease = await claimLease(admin, thread.thread_id)
  if (!lease) return refuse(409, 'busy', AGENT_COPY.busy)

  const ctx: AgentContext = {
    admin,
    userId: user.id,
    userEmail: user.email ?? '',
    apiKeys,
    // Unknown counts as a demo: the demo rules only take things away.
    isDemo: apiKeys.isDemo !== false,
    threadId: thread.thread_id,
    conversationId: conversation.id,
    autonomy: 'ask',
    // The route replaces this with the request's trace id before the turn starts.
    traceId: '',
    signal: input.signal,
    deadlineAt: newDeadline(),
  }
  return { ok: true, ctx, lease, mode }
}
