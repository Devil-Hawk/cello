// The factory's calls on the person's own OpenAI and Anthropic keys: what goes out (a PDF as
// each vendor wants it, JSON mode where the vendor has one) and what comes back in LlmResult's shape.
// No network: fetch is stubbed before each model is built, because the vendor clients keep it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from '../harness/types'
import { callDirect } from './factory'

const ORIGINAL_FETCH = global.fetch
afterEach(() => {
  global.fetch = ORIGINAL_FETCH
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Stubs fetch with the vendor's own reply shape and returns what the first request carried. */
function stub(vendor: 'openai' | 'anthropic') {
  const fetchMock = vi.fn(async () =>
    vendor === 'anthropic'
      ? json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '# Resume' }], stop_reason: 'max_tokens', usage: { input_tokens: 30, output_tokens: 8 } })
      : json({ id: 'x', object: 'chat.completion', created: 1, model: 'gpt-5.2', choices: [{ index: 0, message: { role: 'assistant', content: '# Resume' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } })
  )
  global.fetch = fetchMock as unknown as typeof fetch
  return () => JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
}

const FILE = { mimeType: 'application/pdf', data: 'QUJD' }
const keys = (extra: Partial<DecryptedApiKeys>): DecryptedApiKeys => ({ ...extra })

describe('callDirect', () => {
  it('sends a PDF to Anthropic as a document block and names the model the way the price table does', async () => {
    const sent = stub('anthropic')
    const result = await callDirect('anthropic', keys({ anthropic: 'k' }), { prompt: 'read this', files: [FILE], maxTokens: 100 })

    expect(sent().messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'read this' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } }] }])
    expect(sent().model).toBe('claude-sonnet-5')
    expect(result).toMatchObject({ content: '# Resume', model: 'anthropic/claude-sonnet-5', promptTokens: 30, completionTokens: 8, tokensUsed: 38, finishReason: 'length' })
  })

  it('sends a PDF to OpenAI as a file part, asks for JSON when told to, and reports its tokens', async () => {
    const sent = stub('openai')
    const result = await callDirect('openai', keys({ openai: 'k', model: 'openai/gpt-5.2' }), { prompt: 'read this', files: [FILE], json: true })

    expect(sent().messages[0].content).toEqual([
      { type: 'text', text: 'read this' },
      { type: 'file', file: { filename: 'attachment-1.pdf', file_data: 'data:application/pdf;base64,QUJD' } },
    ])
    expect(sent().response_format).toEqual({ type: 'json_object' })
    expect(result).toMatchObject({ content: '# Resume', model: 'openai/gpt-5.2', promptTokens: 30, completionTokens: 8, tokensUsed: 38, finishReason: 'stop' })
  })

  it('says which key is missing', async () => {
    await expect(callDirect('anthropic', keys({ openai: 'k' }), { prompt: 'hi' })).rejects.toThrow('No Anthropic API key configured')
    await expect(callDirect('openai', keys({ anthropic: 'k' }), { prompt: 'hi' })).rejects.toThrow('No OpenAI API key configured')
  })
})
