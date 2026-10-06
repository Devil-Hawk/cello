import { describe, expect, it } from 'vitest'
import { fakeFetcher, fixture } from '../ingest/reader/fake-fetcher'
import { previewPosting, restoreClearedPosting } from './preview'

const META = 'https://www.metacareers.com/profile/job_details/1616812923224613/'

describe('roles.preview', () => {
  it('reads one posting live and captures it as a stored role would be, with no database in reach', async () => {
    const f = fakeFetcher({ [META]: fixture('meta-job.html') })
    const out = await previewPosting({ url: META, fetcher: f })
    expect(out).toMatchObject({ title: 'ASIC Validation Engineer, Network Validation & Characterization', description_state: 'full', description_source: 'jsonld' })
    expect(out?.description_md?.length).toBeGreaterThan(200)
    expect(out?.description_md5).toMatch(/^[0-9a-f]{32}$/)
    expect(out?.requirements.version).toBe(2)
    // one request, and nothing written: the function has no way to write
    expect(f.calls).toEqual([META])
  })

  it('answers null for a page that is not that posting, a page that cannot be read and an address that is not a web page', async () => {
    const f = fakeFetcher({ [META]: fixture('meta-job.html'), 'https://acme.test/careers': '<html><body><h1>Careers at Acme</h1><p>Join us.</p></body></html>', 'https://acme.test/down': { status: 503, body: 'no' } })
    expect(await previewPosting({ url: META, title: 'A completely different role', fetcher: f })).toBeNull()
    expect(await previewPosting({ url: 'https://acme.test/careers', fetcher: f })).toBeNull()
    expect(await previewPosting({ url: 'https://acme.test/down', fetcher: f })).toBeNull()
    expect(await previewPosting({ url: 'https://acme.test/robots-blocked', fetcher: fakeFetcher({ 'https://acme.test/robots.txt': 'User-agent: *\nDisallow: /' }) })).toBeNull()
    expect(await previewPosting({ url: 'javascript:alert(1)' })).toBeNull()
    expect(await previewPosting({ url: 'file:///etc/passwd' })).toBeNull()
  })
})

describe('roles.get on a cleared posting', () => {
  function fakeDb(role: Record<string, unknown> | null) {
    const writes: { table: string; patch: Record<string, unknown> }[] = []
    const db = {
      from(table: string) {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: role, error: null }),
          update: (patch: Record<string, unknown>) => (writes.push({ table, patch }), b),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        }
        return b
      },
    }
    return { db: db as never, writes }
  }

  it('reads the posting again and stores the body, keeping the stored apply link when the page states none', async () => {
    const { db, writes } = fakeDb({ id: 'j1', url: META, title: 'ASIC Validation Engineer, Network Validation & Characterization', description_state: 'cleared' })
    const out = await restoreClearedPosting(db, { userId: 'u1', jobId: 'j1', fetcher: fakeFetcher({ [META]: fixture('meta-job.html') }) })
    expect(out?.description_state).toBe('full')
    expect(writes).toHaveLength(1)
    expect(writes[0].table).toBe('jobs')
    expect(writes[0].patch).toMatchObject({ description_state: 'full', description_source: 'jsonld' })
    expect(typeof writes[0].patch.description_md).toBe('string')
    expect('apply_url' in writes[0].patch).toBe(false)
  })

  it('does nothing for a role that is not cleared, one the person does not hold, or a site that cannot be read', async () => {
    const full = fakeDb({ id: 'j1', url: META, title: 'x', description_state: 'full' })
    expect(await restoreClearedPosting(full.db, { userId: 'u1', jobId: 'j1', fetcher: fakeFetcher({ [META]: fixture('meta-job.html') }) })).toBeNull()
    const absent = fakeDb(null)
    expect(await restoreClearedPosting(absent.db, { userId: 'u1', jobId: 'j1' })).toBeNull()
    const down = fakeDb({ id: 'j1', url: META, title: 'x', description_state: 'cleared' })
    expect(await restoreClearedPosting(down.db, { userId: 'u1', jobId: 'j1', fetcher: fakeFetcher({ [META]: { status: 503, body: 'x' } }) })).toBeNull()
    expect(full.writes.length + absent.writes.length + down.writes.length).toBe(0)
  })
})
