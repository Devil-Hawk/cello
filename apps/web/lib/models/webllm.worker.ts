// The R1 model: a small model that runs in the person's own browser through
// LangChain's ChatWebLLM. It is a module worker, so the weights and the GPU work stay
// off the page's main thread, and it is loaded only when R1 is live for the person
// (the relay carrier creates it; nothing imports this file).
//
// It lives in lib/models/ because that is where model construction is allowed. It
// holds no key, no tool and no command: messages in, text out. Both the Cello page
// and the extension's offscreen document start it the same way.
//
// ponytail: temperature and max tokens on the job are not passed on; ChatWebLLM's
// default decoding is used. Pass them when R1 steps need it.

import { ChatWebLLM } from '@langchain/community/chat_models/webllm'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { clampText, R1_MODEL, type LocalRequest } from '../relay/local'

const ctx = self as unknown as {
  postMessage(message: unknown): void
  onmessage: ((e: MessageEvent<{ id: number; messages: LocalRequest['messages'] }>) => void) | null
}

const toMessage = (x: LocalRequest['messages'][number]): BaseMessage =>
  x.role === 'system' ? new SystemMessage(x.content) : x.role === 'user' ? new HumanMessage(x.content) : new AIMessage(x.content)

let model: Promise<ChatWebLLM> | null = null

function load(id: number): Promise<ChatWebLLM> {
  model ??= (async () => {
    const m = new ChatWebLLM({ model: R1_MODEL })
    await m.initialize((p) => ctx.postMessage({ id, progress: p.text }))
    return m
  })()
  // A failed load is tried again on the next job.
  model.catch(() => {
    model = null
  })
  return model
}

ctx.onmessage = async (e) => {
  const { id, messages } = e.data
  try {
    const m = await load(id)
    const out = await m.invoke(messages.map(toMessage))
    ctx.postMessage({ id, text: clampText(typeof out.content === 'string' ? out.content : '') })
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message.slice(0, 500) : 'The browser model failed.' })
  }
}
