// RelayChatModel: a LangChain chat model whose "model" is a carrier on the person's
// own computer or browser. A step that is pinned to R1 or R2 and runs on the hosted
// app builds one of these; the call queues a job, waits for a carrier on Realtime
// (never a polling loop) and returns the text.
//
// A step that waits too long throws RelayWaitError and is re-run later. The re-run
// asks again with the same prompt hash, finds the finished job and returns its text
// without queueing a second one.

import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'
import type { AdminClient } from '@/lib/harness/types'
import {
  type AnyRung,
  JobRequest,
  R1_STEPS,
  RELAY_WAIT_MS,
  RelayCeilingError,
  RelayJobError,
  RelayWaitError,
  type RelayRung,
  promptHash,
  withinCeiling,
} from './protocol'
import { enqueueJob } from './queue'
import { type JobWaiter, realtimeWaiter } from './wait'

export interface RelaySpendNote {
  userId: string
  stepId: string
  rung: RelayRung
  /** The model the carrier says it ran, from the job's result. */
  model: string
  promptText: string
  completionText: string
}

export interface RelayChatModelFields extends BaseChatModelParams {
  admin: AdminClient
  userId: string
  stepId: string
  rung: RelayRung
  /** The person's "Highest Cello may use". A job above it is never queued. */
  ceiling: AnyRung
  waitMs?: number
  waiter?: JobWaiter
  /** Called once with a finished answer, to write the $0 ledger row. Never throws into the step. */
  onAnswer?: (note: RelaySpendNote) => Promise<void> | void
}

const ROLE = { human: 'user', ai: 'assistant', system: 'system' } as const

function textOf(m: BaseMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.map((p) => ((p as { type?: string }).type === 'text' ? ((p as { text?: string }).text ?? '') : '')).join('')
}

export class RelayChatModel extends BaseChatModel {
  readonly admin: AdminClient
  readonly userId: string
  readonly stepId: string
  readonly rung: RelayRung
  readonly ceiling: AnyRung
  readonly waitMs: number
  private readonly waiter: JobWaiter
  private readonly onAnswer?: RelayChatModelFields['onAnswer']

  constructor(fields: RelayChatModelFields) {
    // The service client and the person's id stay out of what LangChain keeps for tracing.
    const { admin, userId, stepId, rung, ceiling, waitMs, waiter, onAnswer, ...base } = fields
    super(base)
    this.admin = admin
    this.userId = userId
    this.stepId = stepId
    this.rung = rung
    this.ceiling = ceiling
    this.waitMs = waitMs ?? RELAY_WAIT_MS
    this.waiter = waiter ?? realtimeWaiter(admin, userId)
    this.onAnswer = onAnswer
  }

  _llmType(): string {
    return 'cello-relay'
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    // Nothing is queued for a rung above the person's ceiling.
    if (!withinCeiling(this.rung, this.ceiling)) throw new RelayCeilingError(this.rung, this.ceiling)
    if (this.rung === 'R1' && !R1_STEPS.has(this.stepId)) throw new RelayJobError(`${this.stepId} is not a step a browser model may run.`)

    const request = JobRequest.parse({
      messages: messages.map((m) => ({
        role: ROLE[m.getType() as keyof typeof ROLE] ?? 'user',
        content: textOf(m),
      })),
    })
    const hash = promptHash(this.stepId, this.rung, request)
    const queued = await enqueueJob(this.admin, {
      userId: this.userId,
      stepId: this.stepId,
      rung: this.rung,
      promptHash: hash,
      request,
    })

    let result = queued.status === 'done' ? queued.result : null
    if (queued.status !== 'done') {
      const row = await this.waiter(queued.jobId, this.waitMs)
      if (!row) throw new RelayWaitError(queued.jobId, this.rung)
      if (row.status !== 'done') throw new RelayJobError(row.error ?? 'The carrier could not run this step.')
      result = row.result
    }

    const text = typeof result?.text === 'string' ? result.text : ''
    if (!text) throw new RelayJobError('The carrier sent no text.')
    try {
      await this.onAnswer?.({
        userId: this.userId,
        stepId: this.stepId,
        rung: this.rung,
        model: result?.model ?? 'unknown',
        promptText: request.messages.map((m) => m.content).join('\n'),
        completionText: text,
      })
    } catch (err) {
      console.error('[relay] could not record a relayed call', err)
    }
    return { generations: [{ text, message: new AIMessage(text) }] }
  }
}
