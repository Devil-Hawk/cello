// GET and POST /api/shortlist: the list is picked once a day and kept, so opening
// the page twice never pays for it twice; a missing key and a spent budget are
// explained, not swallowed.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { BudgetCapError } from '@/lib/harness/spend'

const state = { user: { id: 'u1' } as { id: string } | null, canRun: true, picksOn: true }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({ openrouter: 'k' }) }))
vi.mock('@/lib/harness/llm', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/harness/llm')>()), callLlm: vi.fn() }))
vi.mock('@/lib/harness/llm-key-message', () => ({ canRunLlm: () => state.canRun, missingOpenRouterMessage: () => 'Add an OpenRouter key in Settings.' }))

const readShortlist = vi.fn()
const runDailyShortlist = vi.fn()
vi.mock('@/lib/scoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scoring')>()),
  // The daily picks are off in the product; most of this file checks the route as it will behave once they are on.
  get PICKS_ON() {
    return state.picksOn
  },
  readShortlist: (...a: unknown[]) => readShortlist(...a),
  runDailyShortlist: (...a: unknown[]) => runDailyShortlist(...a),
}))

import { GET, POST } from './route'

const view = (status: 'ready' | 'not_built') => ({ forDate: '2026-10-06', status, picks: status === 'ready' ? [{ position: 1 }] : [], counts: { newRoles: 6, filtered: 2, notAssessed: 1 }, learning: { nReactions: 3, mode: 'learning' } })
const get = (qs = '') => GET(new NextRequest(`http://localhost/api/shortlist${qs}`))
const post = (body: unknown = {}) => POST(new NextRequest('http://localhost/api/shortlist', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'u1' }
  state.canRun = true
  state.picksOn = true
})

describe('GET /api/shortlist', () => {
  it('is 401 for a signed-out visitor', async () => {
    state.user = null
    expect((await get()).status).toBe(401)
  })

  it('says not built when nothing was picked for the day, and returns the list when one was', async () => {
    readShortlist.mockResolvedValueOnce(view('not_built'))
    expect(await (await get('?date=2026-10-06')).json()).toMatchObject({ status: 'not_built', picks: [] })
    readShortlist.mockResolvedValueOnce(view('ready'))
    const res = await get('?date=2026-10-06')
    expect(await res.json()).toMatchObject({ status: 'ready', picks: [{ position: 1 }], learning: { mode: 'learning' } })
    expect(readShortlist).toHaveBeenLastCalledWith(expect.anything(), 'u1', '2026-10-06')
  })

  it('rejects a date that is not a date', async () => {
    expect((await get('?date=tomorrow')).status).toBe(400)
    expect((await get('?date=2026-13-45')).status).toBe(400)
  })
})

describe('POST /api/shortlist', () => {
  it('is 401 for a signed-out visitor', async () => {
    state.user = null
    expect((await post()).status).toBe(401)
  })

  it('while the daily picks are off, answers with the stored view, picks nothing and asks for no key', async () => {
    state.picksOn = false
    state.canRun = false
    readShortlist.mockResolvedValue(view('not_built'))
    const res = await post({ date: '2026-10-06', refresh: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'not_built', picks: [], run: { status: 'off', unfinished: 0 } })
    expect(runDailyShortlist).not.toHaveBeenCalled()
  })

  it('answers from storage and spends nothing when today\'s list already exists', async () => {
    readShortlist.mockResolvedValue(view('ready'))
    const res = await post({ date: '2026-10-06' })
    expect(res.status).toBe(200)
    expect(runDailyShortlist).not.toHaveBeenCalled()
    expect(await res.json()).toMatchObject({ status: 'ready', run: { status: 'ok' } })
  })

  it('picks the list when there is none, and again only when asked to refresh', async () => {
    readShortlist.mockResolvedValueOnce(view('not_built')).mockResolvedValue(view('ready'))
    runDailyShortlist.mockResolvedValue({ status: 'ok', picks: [{}], unfinished: 0, counts: { newRoles: 9, filtered: 3 }, learning: {}, notes: [] })
    const first = await (await post({ date: '2026-10-06' })).json()
    expect(runDailyShortlist).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ status: 'ready', run: { status: 'ok', unfinished: 0 }, counts: { newRoles: 9, filtered: 3 } })
    await post({ date: '2026-10-06', refresh: true })
    expect(runDailyShortlist).toHaveBeenCalledTimes(2)
  })

  it('tells the person how it went when some chance checks did not finish or there is no resume', async () => {
    readShortlist.mockResolvedValueOnce(view('not_built')).mockResolvedValue(view('ready'))
    runDailyShortlist.mockResolvedValue({ status: 'partial', picks: [{}], unfinished: 2, counts: { newRoles: 6, filtered: 0 }, learning: {}, notes: [] })
    expect(await (await post()).json()).toMatchObject({ run: { status: 'partial', unfinished: 2 } })
    readShortlist.mockResolvedValueOnce(view('not_built')).mockResolvedValue(view('not_built'))
    runDailyShortlist.mockResolvedValue({ status: 'no_resume', picks: [], unfinished: 0, counts: { newRoles: 0, filtered: 0 }, learning: {}, notes: [] })
    expect(await (await post()).json()).toMatchObject({ run: { status: 'no_resume' } })
  })

  it('is a 400 with a plain message when there is no model key', async () => {
    readShortlist.mockResolvedValue(view('not_built'))
    state.canRun = false
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Add an OpenRouter key in Settings.', skippedReason: 'no-llm-key' })
    expect(runDailyShortlist).not.toHaveBeenCalled()
  })

  it('is a 402 saying the budget is spent, and a 500 with no internals for anything else', async () => {
    readShortlist.mockResolvedValue(view('not_built'))
    runDailyShortlist.mockRejectedValueOnce(new BudgetCapError(10, 10))
    const spent = await post()
    expect(spent.status).toBe(402)
    expect((await spent.json()).error).toBe("This month's AI budget is used up, so nothing new was picked.")
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    runDailyShortlist.mockRejectedValueOnce(new Error('connection refused at 10.0.0.5'))
    const broken = await post()
    expect(broken.status).toBe(500)
    expect(JSON.stringify(await broken.json())).not.toContain('10.0.0.5')
  })
})
