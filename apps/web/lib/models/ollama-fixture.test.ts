// R2 on a self-hosted Cello: a fixture server answers /v1/chat/completions the way
// Ollama does, and a declared draft step drafts a reply through callLlm, the factory
// and ChatOpenAI pointed at it. No key, no money, and the ledger sees rung R2.
//
// The reply is held to the checks the Writer will run on every draft. They live in
// lib/writing (K17, not on this branch yet), so the plain ones are asserted here and
// the test takes the Writer's own check functions when that package is rebased in.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from '../harness/types'
import { defineModelStep } from '../steps/define'
import { personModels } from './ladder'

const REPLY =
  'Hi Jordan, thanks for getting back to me. Tuesday at 2pm works for a call. I will send the one-page summary of my platform work beforehand. Best, Alex'

let server: Server
const seen: { url?: string; body?: Record<string, unknown>; auth?: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization })
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'llama3.1',
          choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 41, completion_tokens: 38, total_tokens: 79 },
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  vi.stubEnv('VERCEL', '')
  vi.stubEnv('CELLO_SELF_HOSTED', '1')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise((resolve) => server.close(resolve))
})

describe('a self-hosted fixture Ollama drafts a reply', () => {
  it('runs the draft step on R2 through the chat completions endpoint, with no key and no cost', async () => {
    const port = (server.address() as AddressInfo).port
    const keys: DecryptedApiKeys = {
      provider: { active: 'local-server', localCli: 'claude', localServerBaseUrl: `http://127.0.0.1:${port}/v1`, localServerModel: 'llama3.1', localServerEmbeddingModel: '' },
    }
    keys.models = personModels(keys, {})
    expect(keys.models.ceiling).toBe('R2') // nothing else is set up, so R2 is the highest rung

    const draft = defineModelStep({ id: 'draft-follow-up', kind: 'step', measure: 'S6', minRung: 'R2', below: 'Write my own.' })
    const result = await draft.call(keys, { system: 'Write a short reply.', prompt: 'Jordan asked to talk on Tuesday at 2pm.' })

    expect(result.content).toBe(REPLY)
    expect(result.prov).toMatchObject({ step: 'draft-follow-up', model: 'llama3.1', rung: 'R2' })
    expect(result.promptTokens).toBe(41)
    expect(result.costUsd).toBeUndefined()

    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/v1/chat/completions')
    expect(seen[0].body).toMatchObject({ model: 'llama3.1', messages: [{ role: 'system' }, { role: 'user', content: 'Jordan asked to talk on Tuesday at 2pm.' }] })
    expect(seen[0].body).not.toHaveProperty('response_format')

    // The checks every draft must pass: said in plain words, no placeholder left in, no em dash, no exclamation mark.
    expect(result.content).not.toMatch(/[—–]|!|\[[^\]]*\]|\{\{/)
    expect(result.content.split(/\s+/).length).toBeLessThan(120)
  })
})
