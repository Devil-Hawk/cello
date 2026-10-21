import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signContinue } from '@/lib/clock/sign'
import { fakeDb } from '@/lib/companies/fake-db'

const SECRET = 'k'.repeat(32)
const ID = '11111111-1111-4111-8111-111111111111'
let held: ReturnType<typeof fakeDb>
const settle = vi.hoisted(() => vi.fn())
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => held.client }))
vi.mock('@/lib/companies/verify-directory', async (original) => ({ ...(await original<typeof import('@/lib/companies/verify-directory')>()), settleCandidate: settle }))

import { POST } from './route'

const exp = () => Math.floor(Date.now() / 1000) + 60
function call(body: Record<string, unknown>, opts: { signature?: string | null; id?: string } = {}) {
  const raw = JSON.stringify({ exp: exp(), id: opts.id ?? ID, ...body })
  const signature = opts.signature === undefined ? signContinue(raw, SECRET) : opts.signature
  return POST(new NextRequest(`http://localhost/api/directory/jobs/${opts.id ?? ID}`, { method: 'POST', body: raw, headers: signature ? { 'x-cello-signature': signature } : {} }), { params: { id: opts.id ?? ID } })
}
const job = (over: Record<string, unknown> = {}) => ({ id: ID, kind: 'careers_page', candidate_id: 'c1', url: 'https://retellai.com/careers', query: null, state: 'claimed', ...over })
const candidate = { id: 'c1', name: 'Retell AI', domain: 'retellai.com', ats_provider: null, ats_token: null, source: 'person', failed_reads: 0 }
const PAGE = '<html><body><a href="https://boards.greenhouse.io/retell">Open roles</a></body></html>'

beforeEach(() => {
  process.env.AGENT_CONTINUE_SECRET = SECRET
  settle.mockReset()
  settle.mockResolvedValue({ state: 'verified', employerId: 'e1' })
  held = fakeDb({ render_jobs: [job()], directory_candidates: [candidate] })
})

const stored = () => held.tables.render_jobs[0]

describe('POST /api/directory/jobs/[id]', () => {
  it('refuses a bad or missing signature and an expired body, and touches nothing', async () => {
    expect((await call({ ok: true, html: PAGE }, { signature: null })).status).toBe(401)
    expect((await call({ ok: true, html: PAGE }, { signature: 'ab'.repeat(32) })).status).toBe(401)
    expect((await call({ ok: true, html: PAGE, exp: 1 })).status).toBe(401)
    expect(stored().state).toBe('claimed')
    expect(settle).not.toHaveBeenCalled()
  })

  it('settles the candidate from the posted page and marks the job done', async () => {
    const res = await call({ ok: true, html: PAGE, final_url: 'https://www.retellai.com/careers', rung: 'stealth' })
    expect(res.status).toBe(200)
    expect(settle).toHaveBeenCalledTimes(1)
    const [, row, deps, opts] = settle.mock.calls[0]
    expect(row).toMatchObject({ id: 'c1', domain: 'retellai.com' })
    expect(opts).toEqual({ person: true })
    expect(await deps.pageBoards({ careerUrl: null, domain: 'retellai.com' })).toEqual([{ provider: 'greenhouse', token: 'retell' }])
    expect(stored()).toMatchObject({ state: 'done', result: { rung: 'stealth', settled: 'verified', employer_id: 'e1' } })
    expect(stored().done_at).toBeTruthy()
  })

  it('takes no evidence from a page read on another domain', async () => {
    await call({ ok: true, html: PAGE, final_url: 'https://evil.example/careers', rung: 'http' })
    const deps = settle.mock.calls[0][2]
    expect(await deps.pageBoards({ careerUrl: null, domain: 'retellai.com' })).toEqual([])
  })

  it('records why a candidate failed', async () => {
    settle.mockResolvedValue({ state: 'failed', reason: 'no_board', offers: [] })
    await call({ ok: true, html: '<html></html>', final_url: 'https://retellai.com/careers', rung: 'http' })
    expect(stored()).toMatchObject({ state: 'done', result: { settled: 'failed', reason: 'no_board' } })
  })

  it('marks the job failed with the worker\'s class, never its words', async () => {
    await call({ ok: false, error: 'BotWall' })
    expect(stored()).toMatchObject({ state: 'failed', failure: 'BotWall' })
    held = fakeDb({ render_jobs: [job()], directory_candidates: [candidate] })
    await call({ ok: false, error: 'it failed at https://secret.example/x' })
    expect(stored()).toMatchObject({ state: 'failed', failure: 'Error' })
    expect(settle).not.toHaveBeenCalled()
  })

  it('stores the domains of a search on the job and marks it done', async () => {
    held = fakeDb({ render_jobs: [job({ kind: 'web_search', candidate_id: null, url: null, query: 'Retell AI' })] })
    await call({ ok: true, domains: [{ domain: 'RetellAI.com', title: 'Retell AI careers' }, { domain: 'retell.dev', title: 'Retell' }] })
    expect(stored()).toMatchObject({ state: 'done', result: { domains: [{ domain: 'retellai.com', title: 'Retell AI careers' }, { domain: 'retell.dev', title: 'Retell' }] } })
    expect(settle).not.toHaveBeenCalled()
  })

  it('fails a search whose domains are not domains', async () => {
    held = fakeDb({ render_jobs: [job({ kind: 'web_search', candidate_id: null, url: null, query: 'x' })] })
    await call({ ok: true, domains: [{ domain: 'https://a.example/path', title: '' }] })
    expect(stored()).toMatchObject({ state: 'failed', failure: 'BadResult' })
  })

  it('ignores a second answer for a finished job and refuses one for a job nobody claimed', async () => {
    held = fakeDb({ render_jobs: [job({ state: 'done' })] })
    const again = await call({ ok: true, html: PAGE })
    expect(await again.json()).toEqual({ ok: true, already: true })
    held = fakeDb({ render_jobs: [job({ state: 'queued' })] })
    expect((await call({ ok: true, html: PAGE })).status).toBe(409)
    expect((await call({ ok: true }, { id: 'not-an-id' })).status).toBe(404)
    expect(settle).not.toHaveBeenCalled()
  })

  it('refuses an answer signed for another job, and a second answer that lands during the settle writes nothing', async () => {
    expect((await call({ ok: true, html: PAGE, id: '22222222-2222-4222-8222-222222222222' })).status).toBe(401)
    expect(settle).not.toHaveBeenCalled()
    settle.mockImplementation(async () => {
      held.tables.render_jobs[0] = { ...job(), state: 'done', result: { from: 'the other post' } }
      return { state: 'verified', employerId: 'e1' }
    })
    await call({ ok: true, html: PAGE, final_url: 'https://retellai.com/careers' })
    expect(stored()).toMatchObject({ state: 'done', result: { from: 'the other post' } })
  })

  it('leaves the job claimed when the settle throws', async () => {
    settle.mockRejectedValue(new Error('boom https://x.example'))
    expect((await call({ ok: true, html: PAGE, final_url: 'https://retellai.com/careers' })).status).toBe(500)
    expect(stored().state).toBe('claimed')
  })
})
