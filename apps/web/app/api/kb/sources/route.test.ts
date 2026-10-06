// A failed list or create must not hand the underlying error text to the
// client; the real message goes to the server log instead.

import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const DB_MESSAGE = 'relation "kb_sources" does not exist'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
const listed = vi.hoisted(() => ({ rows: null as unknown[] | null }))
vi.mock('@/lib/kb/store', () => ({
  listSources: async () => {
    if (listed.rows) return listed.rows
    throw new Error(DB_MESSAGE)
  },
  createSource: async () => {
    throw new Error(DB_MESSAGE)
  },
}))

import { GET, POST } from './route'

afterEach(() => {
  vi.restoreAllMocks()
  listed.rows = null
})

describe('/api/kb/sources failures', () => {
  it('GET returns a fixed message and logs the real one', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to list sources' })
    expect(log.mock.calls.flat().join(' ')).toContain(DB_MESSAGE)
  })

  it('POST returns a fixed message and logs the real one', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(
      new NextRequest('http://localhost/api/kb/sources', { method: 'POST', body: JSON.stringify({ kind: 'paste' }) })
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create source' })
    expect(log.mock.calls.flat().join(' ')).toContain(DB_MESSAGE)
  })
})

describe('/api/kb/sources list', () => {
  it('lists the sources the person gave Cello and leaves out the pages Cello fetched', async () => {
    listed.rows = [
      { id: 'a', kind: 'paste', material_kind: 'person' },
      { id: 'b', kind: 'company_site', material_kind: 'fetched' },
      { id: 'c', kind: 'dossier', material_kind: 'fetched' },
      { id: 'd', kind: 'url', material_kind: 'person' },
    ]
    const res = await GET()
    const body = (await res.json()) as { sources: Array<{ id: string }> }
    expect(body.sources.map((s) => s.id)).toEqual(['a', 'd'])
  })
})
