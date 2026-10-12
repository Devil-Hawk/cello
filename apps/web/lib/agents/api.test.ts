import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import { InMemoryStore, MemorySaver, interrupt } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({ scoreTrace: vi.fn(async () => undefined) }))
vi.mock('@/lib/observability/langfuse', () => ({ scoreTrace: mocks.scoreTrace }))

import { createArtifact } from './artifacts'
import { editArtifact, listApprovals, readSavedConversation } from './api'
import { createCelloAgent } from './factory'
import { chunkToEvent } from './sse'
import { makeFakeAdmin } from './testing/fake-admin'
import { ScriptedChatModel, callTools, say } from './testing/scripted-model'

function world() {
  const admin = makeFakeAdmin(
    { approvals: [] },
    {
      artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) },
      approvals: { defaults: () => ({ status: 'pending', posted_at: null }) },
    }
  )
  admin.rpcHandlers.artifact_add_version = async (args) => {
    const art = admin.tables.artifacts.find((r) => r.id === args.p_artifact_id && r.user_id === args.p_user_id)
    if (!art) throw new Error('artifact not found for this user')
    art.current_version = (art.current_version as number) + 1
    admin.tables.artifact_versions.push({ artifact_id: art.id, version: art.current_version, author: args.p_author, content: args.p_content, content_text: args.p_content_text, trace_id: args.p_trace_id ?? null })
    return art.current_version
  }
  return admin
}

const letter = (body: string) => ({ text: body })

beforeEach(() => mocks.scoreTrace.mockClear())

describe('listApprovals', () => {
  it('shows the person their own pending approvals with a preview of the words, newest first', async () => {
    const admin = world()
    const a = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Letter to Stripe', content: letter('Dear Dana, I built billing at Acme.'), author: 'cello' })
    const b = await createArtifact(admin, { userId: 'u2', type: 'cover_letter', title: 'Someone else', content: letter('Hello.'), author: 'cello' })
    const row = (id: string, user: string, artifact: string, status: string, created: string) => ({ id, user_id: user, artifact_id: artifact, artifact_version: 1, status, created_at: created, action: 'submit_application' })
    admin.tables.approvals.push(row('p1', 'u1', a.id, 'pending', '2026-10-05T10:00:00Z'), row('p2', 'u1', a.id, 'pending', '2026-10-05T11:00:00Z'), row('p3', 'u1', a.id, 'done', '2026-10-05T12:00:00Z'), row('p4', 'u2', b.id, 'pending', '2026-10-05T12:00:00Z'))
    const cards = await listApprovals(admin, 'u1')
    expect(cards.map((c) => c.approval.id)).toEqual(['p2', 'p1'])
    expect(cards[0].artifact).toMatchObject({ title: 'Letter to Stripe', type: 'cover_letter', version: 1 })
    expect(cards[0].artifact?.preview).toContain('I built billing at Acme.')
    expect((await listApprovals(admin, 'u1', 'all')).map((c) => c.approval.id)).toEqual(['p3', 'p2', 'p1'])
  })
})

describe('editArtifact', () => {
  it('saves the persons words as a new version and scores how far they moved from the draft', async () => {
    const admin = world()
    const a = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Letter', content: letter('Dear Dana, I built billing at Acme and cut release time by forty percent.'), author: 'cello', traceId: 'trace-9' })
    const out = await editArtifact(admin, 'u1', a.id, letter('Dear Dana, I built billing at Acme.'))
    expect(out).toEqual({ ok: true, version: 2 })
    expect(admin.tables.artifact_versions.find((v) => v.version === 2)).toMatchObject({ author: 'user' })
    expect(mocks.scoreTrace).toHaveBeenCalledTimes(1)
    const [trace, name, value] = mocks.scoreTrace.mock.calls[0] as unknown as [string, string, number]
    expect([trace, name]).toEqual(['trace-9', 'draft_edited'])
    expect(value).toBeGreaterThan(0)
    expect(value).toBeLessThan(1)
  })

  it('an unchanged edit scores zero, and editing the persons own version scores nothing', async () => {
    const admin = world()
    const a = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Letter', content: letter('Same words.'), author: 'cello', traceId: 'trace-1' })
    await editArtifact(admin, 'u1', a.id, letter('Same words.'))
    expect(mocks.scoreTrace.mock.calls[0]).toEqual(['trace-1', 'draft_edited', 0])
    await editArtifact(admin, 'u1', a.id, letter('Different words.'))
    // The version being edited is now the person's own, so there is no draft to judge.
    expect(mocks.scoreTrace).toHaveBeenCalledTimes(1)
  })

  it("refuses someone else's document and a body that is not that kind of document, creating no version", async () => {
    const admin = world()
    const a = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Letter', content: letter('x'), author: 'cello' })
    expect(await editArtifact(admin, 'u2', a.id, letter('mine now'))).toMatchObject({ ok: false, status: 404 })
    expect(await editArtifact(admin, 'u1', a.id, { nonsense: true })).toMatchObject({ ok: false, status: 400 })
    expect(admin.tables.artifact_versions).toHaveLength(1)
    expect(mocks.scoreTrace).not.toHaveBeenCalled()
  })
})

describe('readSavedConversation', () => {
  const skillsDir = mkdtempSync(path.join(tmpdir(), 'cello-api-'))
  const agentFor = (saver: MemorySaver, model: ScriptedChatModel, extraTools: unknown[] = []) =>
    createCelloAgent({
      kind: 'orchestrator',
      ctx: { admin: world(), userId: 'u1', userEmail: '', apiKeys: { openrouter: 'k' }, isDemo: false, threadId: 't1', conversationId: null, autonomy: 'ask', traceId: 'x', deadlineAt: Date.now() + 1e6 },
      saver,
      store: new InMemoryStore(),
      model,
      fallbacks: [],
      skillsDir,
      extraTools,
    } as never) as unknown as { invoke: (i: unknown, c: unknown) => Promise<unknown> }

  it('returns the messages in the shape the hook reads, and nothing for a thread that does not exist', async () => {
    const saver = new MemorySaver()
    await agentFor(saver, new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [say('Hello there.')] })).invoke({ messages: [new HumanMessage('hi')] }, { configurable: { thread_id: 't1' } })
    const saved = await readSavedConversation(saver, 't1')
    expect(saved.values.messages.map((m) => (m as { type: string; content: string }).type)).toEqual(['human', 'ai'])
    expect((saved.values.messages[1] as { content: string }).content).toBe('Hello there.')
    expect(saved.interrupts).toEqual([])
    // The same shape the live stream uses.
    expect(chunkToEvent([[], 'values', { messages: [] }]).data).toEqual({ messages: [] })
    expect(await readSavedConversation(saver, 'nope')).toEqual({ values: { messages: [] }, interrupts: [] })
  })

  it('shows the question Cello is waiting on, but not a handover to a fresh request', async () => {
    const saver = new MemorySaver()
    const ask = tool(async () => String(interrupt({ kind: 'question', text: 'Which city?' })), { name: 'ask_person', description: 'Ask the person.', schema: z.object({}) })
    const model = new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [callTools([{ name: 'ask_person' }])] })
    await agentFor(saver, model, [ask]).invoke({ messages: [new HumanMessage('find roles')] }, { configurable: { thread_id: 't1' } })
    const saved = await readSavedConversation(saver, 't1')
    expect(saved.interrupts).toEqual([{ value: { kind: 'question', text: 'Which city?' } }])

    // A slice interrupt is not shown to the person.
    const slicer = tool(async () => String(interrupt({ kind: 'slice' })), { name: 'slice_now', description: 'x', schema: z.object({}) })
    const saver2 = new MemorySaver()
    await agentFor(saver2, new ScriptedChatModel({ model: 'google/gemma-4-26b-a4b-it:free', script: [callTools([{ name: 'slice_now' }])] }), [slicer]).invoke({ messages: [new HumanMessage('go')] }, { configurable: { thread_id: 't2' } })
    expect((await readSavedConversation(saver2, 't2')).interrupts).toEqual([])
  })
})
