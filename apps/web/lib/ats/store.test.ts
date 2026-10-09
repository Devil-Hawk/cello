import { describe, expect, it } from 'vitest'
import { makeSupabaseAtsStore } from './store'

// A client that records which table or rpc it was asked for, and answers every query with no rows.
function recorder() {
  const calls: string[] = []
  const chain: any = new Proxy(() => chain, {
    get: (_t, p) => (p === 'then' ? (res: (v: unknown) => void) => res({ data: [], error: null }) : chain),
    apply: () => chain,
  })
  const client = {
    from: (t: string) => (calls.push(`from:${t}`), chain),
    rpc: (f: string) => (calls.push(`rpc:${f}`), Promise.resolve({ data: [], error: null })),
  }
  return { client, calls }
}

const writes = async (store: ReturnType<typeof makeSupabaseAtsStore>) => {
  await store.evictJobs('c', ['x'])
  await store.upsertJobs([{ company_id: 'c', external_id: 'x' }] as never)
  await store.updateJobs([{ companyId: 'c', externalId: 'x', fields: { title: 't' } }] as never)
  await store.recordSightings('c', ['x'], ['s'] as never)
  await store.clearBoardJobs('c', 's' as never)
}

describe('makeSupabaseAtsStore writer', () => {
  it('writes jobs through the service client and reads through the person', async () => {
    const person = recorder()
    const service = recorder()
    const store = makeSupabaseAtsStore(person.client as never, { lockClient: service.client as never })
    await writes(store)
    await store.listJobs('c')
    expect(service.calls).toEqual(
      expect.arrayContaining(['rpc:evict_company_jobs', 'from:jobs', 'rpc:record_job_sightings', 'rpc:clear_unverified_board_jobs']),
    )
    expect(person.calls).toEqual(['from:jobs']) // listJobs only
  })

  it('sends everything to the one client when there is no service client', async () => {
    const only = recorder()
    await writes(makeSupabaseAtsStore(only.client as never))
    expect(only.calls).toContain('rpc:record_job_sightings')
  })
})
