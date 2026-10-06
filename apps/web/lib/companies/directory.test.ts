import { describe, expect, it } from 'vitest'
import { directoryProgress, listCompanies, searchCompanies } from './directory'
import { fakeDb } from './fake-db'

const retell = { id: 'e1', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', open_count: 12, verified_at: '2026-10-01T00:00:00Z' }

describe('companies.list and companies.search', () => {
  it('list asks only for verified rows, a page at a time, and reads no candidate', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const { client, queries } = fakeDb(
      { directory_candidates: [{ id: 'c1', name: 'Seed only', name_norm: 'seed only', state: 'pending' }] },
      { rpc: { list_company_directory: (args) => (calls.push({ name: 'list_company_directory', args }), [retell]) } }
    )
    const rows = await listCompanies(client, { limit: 10, offset: 20 })
    expect(rows.map((r) => r.name)).toEqual(['Retell AI'])
    expect(calls).toEqual([{ name: 'list_company_directory', args: { p_limit: 10, p_offset: 20 } }])
    expect(queries.filter((q) => q.table === 'directory_candidates')).toEqual([])
  })

  it('search shows a pending candidate as not checked, with no count, and never a failed or an already verified one', async () => {
    const { client } = fakeDb(
      {
        directory_candidates: [
          { id: 'c1', name: 'Retell Labs', name_norm: 'retell labs', domain: null, state: 'pending' },
          { id: 'c2', name: 'Retell Failed', name_norm: 'retell failed', domain: null, state: 'failed', fail_reason: 'not_linked' },
          { id: 'c3', name: 'Retell AI', name_norm: 'retell ai', domain: 'retellai.com', state: 'pending' },
        ],
      },
      { rpc: { search_company_directory: () => [retell] } }
    )
    const found = await searchCompanies(client, ' retell ')
    expect(found.employers.map((e) => e.name)).toEqual(['Retell AI'])
    expect(found.notChecked).toEqual([{ id: 'c1', name: 'Retell Labs', domain: null }])
    expect(JSON.stringify(found.notChecked)).not.toMatch(/open_count|count/)
  })

  it('an empty or one-letter query finds nothing and asks for nothing', async () => {
    const { client, queries } = fakeDb({}, { rpc: { search_company_directory: () => [retell] } })
    expect(await searchCompanies(client, '   ')).toEqual({ employers: [], notChecked: [] })
    expect((await searchCompanies(client, 'r')).notChecked).toEqual([])
    expect(queries.filter((q) => q.table === 'directory_candidates')).toEqual([])
  })

  it('progress is the three counts, zero when the database says nothing', async () => {
    const { client } = fakeDb({}, { rpc: { directory_progress: () => [{ verified: 1200, pending: 39000, failed: 800 }] } })
    expect(await directoryProgress(client)).toEqual({ verified: 1200, pending: 39000, failed: 800 })
    expect(await directoryProgress(fakeDb({}, { rpc: { directory_progress: () => null } }).client)).toEqual({ verified: 0, pending: 0, failed: 0 })
  })
})
