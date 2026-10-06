import { describe, expect, it, vi } from 'vitest'
import { relayTick } from './carrier'
import type { RelayDeps } from './carrier'
import type { LocalConfig } from '../../web/lib/relay/local'
import { relayCall } from './api'

const cfg: LocalConfig = { runtime: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1:8b' }
const job = { job_id: 'j1', claim_id: 'c1', request: { messages: [{ role: 'user' as const, content: 'hi' }] } }

function deps(over: Partial<RelayDeps> = {}): RelayDeps & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    config: async () => cfg,
    browserReady: async () => false,
    runBrowser: async () => 'a browser reply',
    haveToken: async () => true,
    lock: async () => true,
    unlock: vi.fn(async () => undefined),
    keepAlive: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    call: (async (route: string, body: unknown) => {
      calls.push([route, body])
      return route.endsWith('claim') ? { job } : { ok: true }
    }) as RelayDeps['call'],
    run: async () => 'a reply',
    ...over,
  }
}

describe('the extension carrier', () => {
  it('claims once, runs the job and posts the text', async () => {
    const d = deps()
    expect(await relayTick(d)).toBe(true)
    expect(d.calls.map(([r]) => r)).toEqual(['/api/model-jobs/claim', '/api/model-jobs/result'])
    expect(d.calls[0]![1]).toEqual({ rung: 'R2', wait: 0 })
    expect(d.calls[1]![1]).toEqual({ job_id: 'j1', claim_id: 'c1', model: 'llama3.1:8b', text: 'a reply' })
    expect(d.keepAlive.start).toHaveBeenCalledTimes(1)
    expect(d.keepAlive.stop).toHaveBeenCalledTimes(1)
    expect(d.unlock).toHaveBeenCalledTimes(1)
  })

  it('posts an error sentence when the local model fails', async () => {
    const d = deps({ run: async () => { throw new Error('Cello could not reach Ollama on this computer.') } })
    await relayTick(d)
    expect(d.calls[1]![1]).toEqual({ job_id: 'j1', claim_id: 'c1', model: 'llama3.1:8b', error: 'Cello could not reach Ollama on this computer.' })
  })

  it('does nothing without a token or a local model, or while a send holds the lock', async () => {
    for (const over of [{ haveToken: async () => false }, { config: async () => null }, { lock: async () => false }]) {
      const d = deps(over)
      expect(await relayTick(d)).toBe(false)
      expect(d.calls).toEqual([])
    }
  })

  it('releases the lock when the claim finds nothing', async () => {
    const d = deps({ call: (async () => ({ job: null })) as RelayDeps['call'] })
    expect(await relayTick(d)).toBe(false)
    expect(d.unlock).toHaveBeenCalledTimes(1)
    expect(d.keepAlive.stop).toHaveBeenCalledTimes(1)
  })

  it('serves R1 in this browser when R2 has nothing, and holds no long wait then', async () => {
    const d = deps({
      browserReady: async () => true,
      call: (async (route: string, body: { rung?: string }) => {
        d.calls.push([route, body])
        return route.endsWith('claim') ? { job: body.rung === 'R1' ? job : null } : { ok: true }
      }) as RelayDeps['call'],
    })
    expect(await relayTick(d)).toBe(true)
    expect(d.calls.map(([, b]) => b)).toEqual([
      { rung: 'R2', wait: 0 },
      { rung: 'R1', wait: 0 },
      { job_id: 'j1', claim_id: 'c1', model: 'Qwen3-1.7B-q4f16_1-MLC', text: 'a browser reply' },
    ])
  })

  it('serves R1 alone when no model is set up on this computer', async () => {
    const d = deps({ config: async () => null, browserReady: async () => true })
    expect(await relayTick(d)).toBe(true)
    expect(d.calls[0]![1]).toEqual({ rung: 'R1', wait: 0 })
  })

  it('knows two routes only: a fill route cannot be called through it', async () => {
    await expect(relayCall('/api/fill/session' as never, {}, { relayToken: 't' })).rejects.toThrow('not a relay route')
  })
})
