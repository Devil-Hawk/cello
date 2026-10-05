import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  poolEnd: vi.fn(async () => undefined),
  poolConfigs: [] as Record<string, unknown>[],
  saverConfigs: [] as unknown[],
}))

vi.mock('pg', () => ({
  Pool: class {
    constructor(cfg: Record<string, unknown>) {
      h.poolConfigs.push(cfg)
    }
    end = h.poolEnd
  },
}))
vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: class {
    constructor(public pool: unknown, _serde: unknown, public opts: unknown) {
      h.saverConfigs.push(opts)
    }
  },
}))

import { AGENT_SCHEMA, withAgentPersistence } from './persistence'

beforeEach(() => {
  h.poolEnd.mockClear()
  h.poolConfigs.length = 0
  h.saverConfigs.length = 0
  process.env.SUPABASE_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:6543/postgres'
})

describe('withAgentPersistence', () => {
  it('closes the pool when the work succeeds', async () => {
    const out = await withAgentPersistence(async () => 'ok')
    expect(out).toBe('ok')
    expect(h.poolEnd).toHaveBeenCalledTimes(1)
  })

  it('closes the pool when the work throws', async () => {
    await expect(
      withAgentPersistence(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(h.poolEnd).toHaveBeenCalledTimes(1)
  })

  it('uses one small pool on the pooler and creates only the checkpointer, no store', async () => {
    let seen: Record<string, unknown> = {}
    await withAgentPersistence(async (p) => {
      seen = p as unknown as Record<string, unknown>
    })
    expect(h.poolConfigs).toHaveLength(1)
    expect(h.poolConfigs[0]).toMatchObject({ max: 2 })
    expect(h.saverConfigs[0]).toMatchObject({ schema: AGENT_SCHEMA })
    expect(Object.keys(seen)).toEqual(['saver'])
  })

  it('refuses to run without a pooled database url', async () => {
    delete process.env.SUPABASE_DB_URL
    await expect(withAgentPersistence(async () => 1)).rejects.toThrow(/SUPABASE_DB_URL/)
  })
})
