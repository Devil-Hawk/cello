// The chat loop on the real OpenRouter adapter, against a local server that answers like OpenRouter does (no network, no key):
// a structured answer that does not fit is asked for again by Cello, on both the plain and the streaming path chat uses.
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { MemorySaver } from '@langchain/langgraph'
import { ChatOpenRouter } from '@langchain/openrouter'
import { z } from 'zod'
import { createCelloAgent } from './factory'
import { makeFakeAdmin } from './testing/fake-admin'

const Answer = z.object({ text: z.string().max(8) })

async function serve(replies: ((tool: string) => unknown)[]) {
  let n = 0
  const bodies: any[] = []
  const srv = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const body = JSON.parse(b || '{}')
      bodies.push(body)
      const tool = (body.tools ?? []).map((t: any) => t.function.name).find((x: string) => x.startsWith('extract-'))
      const args = (replies[Math.min(n++, replies.length - 1)])(tool)
      const call = { id: `call_${n}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }
      const base = { id: `gen-${n}`, object: body.stream ? 'chat.completion.chunk' : 'chat.completion', created: 1, model: body.model }
      if (!body.stream) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [call] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      const half = Math.floor(call.function.arguments.length / 2)
      const chunk = (delta: any, fin: string | null = null, usage?: any) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: fin }], ...(usage ? { usage } : {}) })}\n\n`
      res.write(chunk({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: tool, arguments: call.function.arguments.slice(0, half) } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: call.function.arguments.slice(half) } }] }))
      res.write(chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/api/v1`, bodies, close: () => srv.close() }
}

describe('a misfit answer on the real OpenRouter adapter', () => {
  for (const mode of ['invoke', 'stream'] as const) {
    it(`${mode}: is asked for again and the second one is taken`, async () => {
      const bad = { text: 'x'.repeat(30) }
      const s = await serve([() => bad, () => ({ text: 'fixed' })])
      const model = new ChatOpenRouter({ model: 'nvidia/nemotron-3-super-120b-a12b:free', apiKey: 'k', baseURL: s.url, maxRetries: 0 } as never)
      const ctx: any = { admin: makeFakeAdmin(), userId: 'u1', userEmail: '', apiKeys: { openrouter: 'k', userId: 'u1' }, isDemo: false, threadId: 't', conversationId: null, autonomy: 'ask', traceId: '', deadlineAt: Date.now() + 120000 }
      const agent: any = createCelloAgent({ kind: 'chat', ctx, saver: new MemorySaver(), model, fallbacks: [], tools: [], responseFormat: Answer as never } as never)
      const cfg = { configurable: { thread_id: `t-${Math.random()}` }, recursionLimit: 80 }
      let out: any
      if (mode === 'invoke') out = await agent.invoke({ messages: [new HumanMessage('hi')] }, cfg)
      else {
        const chunks = await agent.stream({ messages: [new HumanMessage('hi')] }, { ...cfg, streamMode: ['values', 'messages', 'custom'], subgraphs: true })
        for await (const c of chunks) { const [ns, m, d] = c as any; if (ns.length === 0 && m === 'values') out = d }
      }
      expect(out.structuredResponse).toEqual({ text: 'fixed' })
      expect(s.bodies).toHaveLength(2)
      s.close()
    })
  }
})
