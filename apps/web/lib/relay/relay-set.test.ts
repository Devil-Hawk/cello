// The Relay set: twelve cases, bar 1.0, run in CI. Each one names a way a carrier or
// a forged request could get an answer into the wrong job, or a local address that
// is not the person's computer, and proves the relay refuses it.
//
// Case 11 (a relay token at a fill route) is added when K18's fill routes are on main.

import { NextRequest } from 'next/server'
import { HumanMessage } from '@langchain/core/messages'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRelay } from './testing'

const state = vi.hoisted(() => ({ admin: null as unknown, user: null as { id: string } | null }))

vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => state.admin }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}))
vi.mock('@/lib/access/tokens', () => ({
  validateToken: async (_admin: unknown, bearer: string) =>
    bearer === 'cello_pat_relay'
      ? { ok: true, userId: 'user-a', scopes: ['relay'] }
      : bearer === 'cello_pat_fill'
        ? { ok: true, userId: 'user-a', scopes: ['fill:extension'] }
        : { ok: false, reason: 'unknown' },
}))

import { POST as claimRoute } from '@/app/api/model-jobs/claim/route'
import { POST as resultRoute } from '@/app/api/model-jobs/result/route'
import { RelayChatModel } from './chat-model'
import { assertLoopback, runLocal } from './local'
import { promptHash, RelayWaitError } from './protocol'
import { claimJob, completeJob, enqueueJob } from './queue'

const A = 'user-a'
const B = 'user-b'
const OTHER_CLAIM = '11111111-1111-4111-8111-111111111111'
const request = { messages: [{ role: 'user' as const, content: 'sort this mail' }] }

let relay: ReturnType<typeof fakeRelay>

// The fake queue plus a profile read that says "not a demo".
function adminWithProfiles(r: ReturnType<typeof fakeRelay>): unknown {
  const real = r.admin as unknown as { from: (t: string) => unknown; rpc: unknown }
  return {
    rpc: (...a: unknown[]) => (real.rpc as (...x: unknown[]) => unknown)(...a),
    from: (t: string) => {
      if (t !== 'profiles') return real.from(t)
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { is_demo: false, demo_expires_at: null }, error: null }) }
      return q
    },
  }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const asRelayToken = { authorization: 'Bearer cello_pat_relay' }

async function queue(user: string, step = 'inbox.classify', rung: 'R1' | 'R2' = 'R2') {
  return enqueueJob(relay.admin, { userId: user, stepId: step, rung, promptHash: promptHash(step, rung, request), request })
}

beforeEach(() => {
  relay = fakeRelay()
  state.admin = adminWithProfiles(relay)
  state.user = null
})

describe('the result route', () => {
  async function claimed() {
    const q = await queue(A)
    const job = await claimJob(relay.admin, A, 'R2')
    return { jobId: q.jobId, claimId: job!.claim_id }
  }

  it('1 refuses a body without a job, a claim and text or an error', async () => {
    const res = await resultRoute(post('/api/model-jobs/result', { job_id: 'x', model: 'llama3.1:8b', text: 'hi' }, asRelayToken))
    expect(res.status).toBe(400)
  })

  it('1b refuses a result that names no model, and the job stays claimed', async () => {
    const { jobId, claimId } = await claimed()
    const res = await resultRoute(post('/api/model-jobs/result', { job_id: jobId, claim_id: claimId, text: 'hi' }, asRelayToken))
    expect(res.status).toBe(400)
    expect(relay.jobs[0]!.status).toBe('claimed')
  })

  it('2 refuses a wrong claim id', async () => {
    const { jobId } = await claimed()
    const res = await resultRoute(post('/api/model-jobs/result', { job_id: jobId, claim_id: OTHER_CLAIM, model: 'llama3.1:8b', text: 'hi' }, asRelayToken))
    expect(res.status).toBe(409)
    expect(relay.jobs[0]!.status).toBe('claimed')
  })

  it('3 refuses another person\'s job', async () => {
    const { jobId, claimId } = await claimed()
    // The same token holder is person A; the job belongs to B.
    relay.jobs[0]!.user_id = B
    const res = await resultRoute(post('/api/model-jobs/result', { job_id: jobId, claim_id: claimId, model: 'llama3.1:8b', text: 'hi' }, asRelayToken))
    expect(res.status).toBe(409)
  })

  it('4 refuses a job nobody claimed', async () => {
    const q = await queue(A)
    const res = await resultRoute(post('/api/model-jobs/result', { job_id: q.jobId, claim_id: OTHER_CLAIM, model: 'llama3.1:8b', text: 'hi' }, asRelayToken))
    expect(res.status).toBe(409)
    expect(relay.jobs[0]!.status).toBe('queued')
  })

  it('5 refuses a result over 64 KB before it touches the queue', async () => {
    const { jobId, claimId } = await claimed()
    const rpc = vi.spyOn(relay.admin, 'rpc')
    const res = await resultRoute(post('/api/model-jobs/result', { job_id: jobId, claim_id: claimId, model: 'm', text: 'x'.repeat(70_000) }, asRelayToken))
    expect(res.status).toBe(413)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('6 takes one answer per claim and refuses the second', async () => {
    const { jobId, claimId } = await claimed()
    const first = await resultRoute(post('/api/model-jobs/result', { job_id: jobId, claim_id: claimId, model: 'llama3.1:8b', text: 'one' }, asRelayToken))
    const second = await resultRoute(post('/api/model-jobs/result', { job_id: jobId, claim_id: claimId, model: 'llama3.1:8b', text: 'two' }, asRelayToken))
    expect([first.status, second.status]).toEqual([200, 409])
    expect(relay.jobs[0]!.result).toEqual({ text: 'one', model: 'llama3.1:8b' })
    expect(relay.jobs[0]!.prov).toMatchObject({ step: 'inbox.classify', model: 'llama3.1:8b', rung: 'R2', evidence: [] })
  })
})

describe('loopback only', () => {
  it('7 refuses every address that is not this computer', () => {
    for (const u of ['http://192.168.1.5:11434', 'http://example.com', 'http://127.0.0.1.nip.io:11434', 'http://0.0.0.0:11434', 'file:///etc/passwd', 'http://user@127.0.0.1', 'not a url']) {
      expect(() => assertLoopback(u), u).toThrow()
    }
    for (const u of ['http://127.0.0.1:11434', 'http://localhost:1234', 'http://[::1]:8080']) expect(assertLoopback(u).hostname).toBeTruthy()
  })

  it('7 makes no request to an address that is not this computer', async () => {
    const doFetch = vi.fn()
    await expect(runLocal({ runtime: 'ollama', baseUrl: 'http://192.168.1.5:11434', model: 'm' }, request, doFetch)).rejects.toThrow()
    expect(doFetch).not.toHaveBeenCalled()
  })
})

describe('RelayChatModel', () => {
  const model = (over: Partial<ConstructorParameters<typeof RelayChatModel>[0]> = {}) =>
    new RelayChatModel({ admin: relay.admin, userId: A, stepId: 'inbox.classify', rung: 'R2', ceiling: 'R3', waitMs: 5, ...over })

  it('8 returns a job that is already done without waiting', async () => {
    const q = await queue(A)
    const job = await claimJob(relay.admin, A, 'R2')
    await completeJob(relay.admin, { userId: A, jobId: q.jobId, claimId: job!.claim_id, model: 'llama3.1:8b', text: 'noise' })
    const waiter = vi.fn()
    const out = await model({ waiter }).invoke([new HumanMessage('sort this mail')])
    expect(out.content).toBe('noise')
    expect(waiter).not.toHaveBeenCalled()
  })

  it('8b tells the ledger which model answered', async () => {
    const q = await queue(A)
    const job = await claimJob(relay.admin, A, 'R2')
    await completeJob(relay.admin, { userId: A, jobId: q.jobId, claimId: job!.claim_id, model: 'llama3.1:8b', text: 'noise' })
    const onAnswer = vi.fn()
    await model({ onAnswer }).invoke([new HumanMessage('sort this mail')])
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.1:8b' }))
  })

  it('9 throws RelayWaitError when no one answers, and the re-run asks nothing new and reads the answer once', async () => {
    const m = model({ waiter: async () => null })
    await expect(m.invoke([new HumanMessage('sort this mail')])).rejects.toBeInstanceOf(RelayWaitError)
    expect(relay.jobs).toHaveLength(1)

    const job = await claimJob(relay.admin, A, 'R2')
    await completeJob(relay.admin, { userId: A, jobId: job!.job_id, claimId: job!.claim_id, model: 'llama3.1:8b', text: 'late answer' })

    const out = await model({ waiter: async () => null }).invoke([new HumanMessage('sort this mail')])
    expect(out.content).toBe('late answer')
    expect(relay.jobs).toHaveLength(1)
  })

  it('12 refuses an R1 job for a step a browser model may not run, before anything is queued', async () => {
    await expect(model({ stepId: 'writer.draft', rung: 'R1' }).invoke([new HumanMessage('write a reply')])).rejects.toThrow(/writer\.draft/)
    expect(relay.jobs).toHaveLength(0)
  })
})

describe('the claim route', () => {
  const claim = (headers: Record<string, string> = {}) => claimRoute(post('/api/model-jobs/claim', { rung: 'R2' }, headers))

  it('10 answers 401 with nothing, 403 to a token without relay, 200 to a relay token', async () => {
    expect((await claim({ 'sec-fetch-site': 'same-origin' })).status).toBe(401)
    expect((await claim({ authorization: 'Bearer cello_pat_fill' })).status).toBe(403)
    await queue(A)
    const ok = await claim(asRelayToken)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { job: { step_id: string } }).job.step_id).toBe('inbox.classify')
  })

  it('hands a person only their own jobs', async () => {
    await queue(B)
    const res = await claim(asRelayToken)
    expect(((await res.json()) as { job: unknown }).job).toBeNull()
  })
})
