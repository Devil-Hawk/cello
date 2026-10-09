import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchStreamTransport } from '@langchain/langgraph-sdk/ui'
import { AGENT_COPY } from './copy'
import { agentFetch, errorMessage } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

// HTTP/2: the status line carries no text, so statusText is empty.
const http2 = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, statusText: '', headers: { 'content-type': 'application/json' } })

async function failure(res: Response): Promise<unknown> {
  vi.stubGlobal('fetch', async () => res)
  const transport = new FetchStreamTransport({ apiUrl: 'http://test/api/agent/stream', fetch: agentFetch })
  try {
    await transport.stream({ input: {}, signal: new AbortController().signal } as never)
  } catch (e) {
    return e
  }
  return null
}

describe('agentFetch with the hook transport', () => {
  it('shows the sentence the route sent, not an empty status', async () => {
    const e = await failure(http2(402, { error: 'needs_key', message: AGENT_COPY.needsKey }))
    expect(errorMessage(e)).toBe(AGENT_COPY.needsKey)
  })

  it('without the wrapper the hook would have had nothing to show', async () => {
    vi.stubGlobal('fetch', async () => http2(402, { message: AGENT_COPY.needsKey }))
    const transport = new FetchStreamTransport({ apiUrl: 'http://test/api/agent/stream' })
    const e = await transport.stream({ input: {}, signal: new AbortController().signal } as never).catch((err) => err)
    expect(errorMessage(e)).toBe(AGENT_COPY.generic)
  })

  it('every refusal the route can send comes through as its own sentence', async () => {
    for (const message of [AGENT_COPY.busy, AGENT_COPY.oldConversation, AGENT_COPY.demoExpired, AGENT_COPY.signIn, AGENT_COPY.notFound]) {
      expect(errorMessage(await failure(http2(409, { message })))).toBe(message)
    }
  })

  it('a failure with no usable body says the plain generic sentence, never a status code', async () => {
    expect(errorMessage(await failure(new Response('<html>Bad gateway</html>', { status: 502 })))).toBe(AGENT_COPY.generic)
    expect(errorMessage(await failure(http2(500, { message: '   ' })))).toBe(AGENT_COPY.generic)
  })

  it('a sentence with a line break cannot break the status line', async () => {
    expect(errorMessage(await failure(http2(409, { message: 'First line.\nSecond line.' })))).toBe('First line. Second line.')
  })

  it('a good response passes through untouched', async () => {
    const ok = new Response('data', { status: 200 })
    vi.stubGlobal('fetch', async () => ok)
    expect(await agentFetch('/x')).toBe(ok)
  })
})

describe('errorMessage', () => {
  it('knows nothing about an error it did not make', () => {
    expect(errorMessage(new Error('TypeError: x is not a function'))).toBe(AGENT_COPY.generic)
    expect(errorMessage(undefined)).toBe(AGENT_COPY.generic)
    expect(errorMessage('Failed to stream: Hello.')).toBe('Hello.')
  })
})
