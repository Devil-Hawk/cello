import { describe, expect, it } from 'vitest'
import { DemoAccessError, demoSessionGate } from '@/lib/access/guardrails'
import { AGENT_COPY } from './copy'
import { claimLease } from './scheduler'
import { makeFakeAdmin } from './testing/fake-admin'
import { openUserTurn, StreamBodySchema, textOfContent, type StreamBody } from './turn'

const USER = { id: 'u1', email: 'dana@example.com' }
const keys = (over: Record<string, unknown> = {}) => async () => ({ openrouter: 'k', userId: 'u1', isDemo: false, ...over }) as never

function world(seed: Record<string, Record<string, unknown>[]> = {}) {
  return makeFakeAdmin(
    { profiles: [{ id: 'u1', is_demo: false, demo_expires_at: null }], copilot_conversations: [], graph_threads: [], ...seed },
    {
      copilot_conversations: { defaults: () => ({ id: crypto.randomUUID(), thread_id: null, title: 'New chat' }) },
      graph_threads: { defaults: () => ({ thread_id: crypto.randomUUID(), lease_until: null, lease_holder: null, expires_at: null }) },
    }
  )
}

const say = (text: string, conversationId?: string): StreamBody => StreamBodySchema.parse({ input: { messages: [{ type: 'human', content: text }] }, ...(conversationId ? { context: { conversationId } } : {}) })

describe('openUserTurn', () => {
  it('starts a conversation and its thread on the first message, links them, and holds the lease', async () => {
    const admin = world()
    const out = await openUserTurn({ admin, user: USER, body: say('find me roles in Austin'), loadKeys: keys() })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.mode).toEqual({ kind: 'input', text: 'find me roles in Austin' })
    expect(admin.tables.copilot_conversations).toHaveLength(1)
    expect(admin.tables.copilot_conversations[0]).toMatchObject({ user_id: 'u1', title: 'find me roles in Austin', thread_id: out.ctx.threadId })
    expect(admin.tables.graph_threads[0]).toMatchObject({ user_id: 'u1', surface: 'agent', conversation_id: out.ctx.conversationId })
    expect(out.ctx).toMatchObject({ userId: 'u1', autonomy: 'ask', isDemo: false, conversationId: admin.tables.copilot_conversations[0].id })
    expect(out.ctx.deadlineAt).toBeGreaterThan(Date.now() + 200_000)
    // Nobody else can take the thread while the turn runs.
    expect(await claimLease(admin, out.ctx.threadId)).toBeNull()
  })

  it('reuses the conversation and thread on the next message', async () => {
    const admin = world()
    const first = await openUserTurn({ admin, user: USER, body: say('hello'), loadKeys: keys() })
    if (!first.ok) throw new Error('first turn refused')
    const second = await openUserTurn({ admin, user: USER, body: say('and again', first.ctx.conversationId!), loadKeys: keys() })
    // The first turn still holds the lease, so the second is told to wait.
    expect(second).toMatchObject({ ok: false, status: 409, error: 'busy', message: AGENT_COPY.busy })
    admin.tables.graph_threads[0].lease_until = null
    const third = await openUserTurn({ admin, user: USER, body: say('and again', first.ctx.conversationId!), loadKeys: keys() })
    expect(third.ok && third.ctx.threadId).toBe(first.ctx.threadId)
    expect(admin.tables.graph_threads).toHaveLength(1)
    expect(admin.tables.copilot_conversations).toHaveLength(1)
  })

  it('an answer to a question is a resume, and needs a conversation', async () => {
    const admin = world()
    const noConversation = await openUserTurn({ admin, user: USER, body: StreamBodySchema.parse({ command: { resume: 'Austin' } }), loadKeys: keys() })
    expect(noConversation).toMatchObject({ ok: false, status: 400 })
    const first = await openUserTurn({ admin, user: USER, body: say('hello'), loadKeys: keys() })
    if (!first.ok) throw new Error('refused')
    admin.tables.graph_threads[0].lease_until = null
    const resumed = await openUserTurn({ admin, user: USER, body: StreamBodySchema.parse({ command: { resume: 'Austin' }, context: { conversationId: first.ctx.conversationId } }), loadKeys: keys() })
    expect(resumed.ok && resumed.mode).toEqual({ kind: 'resume', value: 'Austin' })
  })

  it('refuses an empty message, with no conversation created', async () => {
    const admin = world()
    const out = await openUserTurn({ admin, user: USER, body: say('   '), loadKeys: keys() })
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(admin.tables.copilot_conversations).toHaveLength(0)
  })

  it('says to add a key with a 402 and creates nothing', async () => {
    const admin = world()
    const out = await openUserTurn({ admin, user: USER, body: say('hi'), loadKeys: async () => ({ userId: 'u1', isDemo: false }) as never })
    expect(out).toEqual({ ok: false, status: 402, error: 'needs_key', message: AGENT_COPY.needsKey })
    expect(admin.tables.copilot_conversations).toHaveLength(0)
  })

  it('an expired demo is told so', async () => {
    const admin = world()
    const out = await openUserTurn({
      admin,
      user: USER,
      body: say('hi'),
      loadKeys: async () => {
        throw new DemoAccessError(demoSessionGate(null))
      },
    })
    expect(out).toEqual({ ok: false, status: 403, error: 'demo_expired', message: AGENT_COPY.demoExpired })
  })

  it("someone else's conversation is not found, the same as a missing one", async () => {
    const admin = world({ copilot_conversations: [{ id: '11111111-1111-4111-8111-111111111111', user_id: 'u2', thread_id: null, title: 'x' }] })
    const out = await openUserTurn({ admin, user: USER, body: say('hi', '11111111-1111-4111-8111-111111111111'), loadKeys: keys() })
    expect(out).toMatchObject({ ok: false, status: 404, message: AGENT_COPY.notFound })
    const missing = await openUserTurn({ admin, user: USER, body: say('hi', '22222222-2222-4222-8222-222222222222'), loadKeys: keys() })
    expect(missing).toEqual(out)
  })

  it('a conversation from the earlier Copilot stays readable but says to start a new one', async () => {
    const cid = '33333333-3333-4333-8333-333333333333'
    const tid = '44444444-4444-4444-8444-444444444444'
    const admin = world({
      copilot_conversations: [{ id: cid, user_id: 'u1', thread_id: tid, title: 'old' }],
      graph_threads: [{ thread_id: tid, user_id: 'u1', surface: 'copilot', lease_until: null, lease_holder: null, expires_at: null }],
    })
    const out = await openUserTurn({ admin, user: USER, body: say('hi', cid), loadKeys: keys() })
    expect(out).toEqual({ ok: false, status: 409, error: 'old_conversation', message: AGENT_COPY.oldConversation })
  })

  it("someone else's thread on my conversation is not found", async () => {
    const cid = '33333333-3333-4333-8333-333333333333'
    const tid = '44444444-4444-4444-8444-444444444444'
    const admin = world({
      copilot_conversations: [{ id: cid, user_id: 'u1', thread_id: tid, title: 'mine' }],
      graph_threads: [{ thread_id: tid, user_id: 'u2', surface: 'agent', lease_until: null, lease_holder: null, expires_at: null }],
    })
    expect(await openUserTurn({ admin, user: USER, body: say('hi', cid), loadKeys: keys() })).toMatchObject({ ok: false, status: 404 })
  })

  it('treats an account that is not proven to be the owner as a demo', async () => {
    const admin = world()
    const out = await openUserTurn({ admin, user: USER, body: say('hi'), loadKeys: keys({ isDemo: undefined }) })
    expect(out.ok && out.ctx.isDemo).toBe(true)
    const owner = await openUserTurn({ admin: world(), user: USER, body: say('hi'), loadKeys: keys({ isDemo: false }) })
    expect(owner.ok && owner.ctx.isDemo).toBe(false)
  })
})

describe('textOfContent', () => {
  it('reads a string, and the text blocks of a block list', () => {
    expect(textOfContent('hi')).toBe('hi')
    expect(textOfContent([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: 'x' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOfContent(undefined)).toBe('')
  })
})

describe('the body schema', () => {
  it('accepts what the hook sends, with extra fields, and rejects a bad conversation id', () => {
    expect(StreamBodySchema.safeParse({ input: { messages: [{ type: 'human', content: 'x' }] }, config: { a: 1 }, streamMode: ['values'] }).success).toBe(true)
    expect(StreamBodySchema.safeParse({ context: { conversationId: 'nope' } }).success).toBe(false)
    expect(StreamBodySchema.safeParse({ input: { messages: [] } }).success).toBe(false)
  })
})
