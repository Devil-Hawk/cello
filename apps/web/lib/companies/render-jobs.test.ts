import { beforeEach, describe, expect, it } from 'vitest'
import { signContinue } from '../clock/sign'
import { fakeDb } from './fake-db'
import { queueRenderJob, readSigned } from './render-jobs'

const SECRET = 'k'.repeat(32)
const NOW = 1_792_000_000_000
const sign = (raw: string) => signContinue(raw, SECRET)

beforeEach(() => {
  process.env.AGENT_CONTINUE_SECRET = SECRET
})

describe('queueRenderJob', () => {
  const db = (seed: Record<string, Record<string, unknown>[]> = {}) => fakeDb(seed, { autoId: ['render_jobs', 'directory_candidates'] })

  it('queues a careers page and rests its candidate for a day', async () => {
    const { client, tables } = db({ directory_candidates: [{ id: 'c1', next_check_at: '2020-01-01T00:00:00Z' }] })
    const id = await queueRenderJob(client, { kind: 'careers_page', candidateId: 'c1', url: 'https://retellai.com/careers' })
    expect(tables.render_jobs).toEqual([{ id, kind: 'careers_page', candidate_id: 'c1', url: 'https://retellai.com/careers', query: null }])
    expect(Date.parse(tables.directory_candidates[0].next_check_at as string)).toBeGreaterThan(Date.now() + 23 * 3_600_000)
  })

  it('queues a search by its words', async () => {
    const { client, tables } = db()
    await queueRenderJob(client, { kind: 'web_search', query: ' Retell AI ' })
    expect(tables.render_jobs[0]).toMatchObject({ kind: 'web_search', url: null, query: 'Retell AI' })
  })

  it('does not queue the same page twice while one waits or is being read', async () => {
    const { client, tables } = db({ render_jobs: [{ id: 'j1', kind: 'careers_page', url: 'https://a.example/c', state: 'claimed' }] })
    expect(await queueRenderJob(client, { kind: 'careers_page', url: 'https://a.example/c' })).toBe('j1')
    expect(tables.render_jobs).toHaveLength(1)
  })

  it('queues again once the earlier job is finished', async () => {
    const { client, tables } = db({ render_jobs: [{ id: 'j1', kind: 'careers_page', url: 'https://a.example/c', state: 'failed' }] })
    expect(await queueRenderJob(client, { kind: 'careers_page', url: 'https://a.example/c' })).not.toBe('j1')
    expect(tables.render_jobs).toHaveLength(2)
  })

  it('refuses what is not a job', async () => {
    const { client, tables } = db()
    expect(await queueRenderJob(client, { kind: 'careers_page' })).toBeNull()
    expect(await queueRenderJob(client, { kind: 'careers_page', url: 'javascript:alert(1)' })).toBeNull()
    expect(await queueRenderJob(client, { kind: 'web_search', query: '   ' })).toBeNull()
    expect(tables.render_jobs ?? []).toEqual([])
  })
})

describe('readSigned', () => {
  const exp = NOW / 1000
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({ exp: exp + 60, ...over })

  it('gives the body once the signature and the expiry check out', () => {
    const raw = body({ ok: true })
    expect(readSigned(raw, sign(raw), NOW)).toEqual({ ok: true, body: { exp: exp + 60, ok: true } })
  })

  it('refuses a missing, wrong or other-body signature with the same 401', () => {
    const raw = body()
    expect(readSigned(raw, null, NOW)).toEqual({ ok: false, status: 401 })
    expect(readSigned(raw, 'ab', NOW)).toEqual({ ok: false, status: 401 })
    expect(readSigned(raw, sign(body({ ok: false })), NOW)).toEqual({ ok: false, status: 401 })
  })

  it('refuses an expiry in the past or too far ahead', () => {
    const past = body({ exp: exp - 1 })
    const far = body({ exp: exp + 3600 })
    expect(readSigned(past, sign(past), NOW)).toEqual({ ok: false, status: 401 })
    expect(readSigned(far, sign(far), NOW)).toEqual({ ok: false, status: 401 })
  })

  it('checks the signature before it reads the body', () => {
    expect(readSigned('not json', 'ab', NOW)).toEqual({ ok: false, status: 401 })
    expect(readSigned('not json', sign('not json'), NOW)).toEqual({ ok: false, status: 400 })
  })

  it('answers 503 when the deployment has no secret', () => {
    delete process.env.AGENT_CONTINUE_SECRET
    expect(readSigned(body(), 'ab', NOW)).toEqual({ ok: false, status: 503 })
  })
})
