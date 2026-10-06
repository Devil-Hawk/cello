// A scripted chat model for tests: it answers with queued messages, one per call,
// and records what it was sent. No network, no key. Tests use it to drive a real
// agent (guards, subagents, checkpointer) deterministically.

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'

export type ScriptStep = AIMessage | Error | ((messages: BaseMessage[]) => AIMessage | Error)

export interface ToolCallSpec {
  name: string
  args?: Record<string, unknown>
  id?: string
}

let counter = 0

/** An assistant turn that asks for tools, with usage so spend can settle. */
export function callTools(calls: ToolCallSpec[], usage = { input_tokens: 100, output_tokens: 20 }): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: calls.map((c) => ({ name: c.name, args: c.args ?? {}, id: c.id ?? `call_${++counter}`, type: 'tool_call' as const })),
    usage_metadata: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
  })
}

/** A plain assistant answer. */
export function say(text: string, usage = { input_tokens: 100, output_tokens: 20 }): AIMessage {
  return new AIMessage({
    content: text,
    usage_metadata: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
  })
}

export class ScriptedChatModel extends BaseChatModel {
  model: string
  maxTokens: number
  /** Every message list this model was called with. */
  calls: BaseMessage[][] = []
  /** Names of the tools bound at the last call. */
  boundTools: string[] = []
  private script: ScriptStep[]
  /** What to answer once the script runs out. Defaults to repeating the last step. */
  private repeatLast: boolean

  constructor(opts: { model?: string; maxTokens?: number; script: ScriptStep[]; repeatLast?: boolean }) {
    super({})
    this.model = opts.model ?? 'test/scripted'
    this.maxTokens = opts.maxTokens ?? 1024
    this.script = [...opts.script]
    this.repeatLast = opts.repeatLast ?? false
  }

  _llmType(): string {
    return 'scripted'
  }

  // Both createAgent and Deep Agents bind tools before calling; the binding is recorded, the model is unchanged.
  bindTools(tools: unknown[]): this {
    this.boundTools = tools.map((t) => (t as { name?: string }).name ?? '')
    return this
  }

  get remaining(): number {
    return this.script.length
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    let step = this.script.length > 1 || !this.repeatLast ? this.script.shift() : this.script[0]
    if (step === undefined) step = say('(script ended)')
    const resolved = typeof step === 'function' ? step(messages) : step
    if (resolved instanceof Error) throw resolved
    return { generations: [{ message: resolved, text: typeof resolved.content === 'string' ? resolved.content : '' }] }
  }
}
