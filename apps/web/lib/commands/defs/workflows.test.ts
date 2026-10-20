// documents.draft under the Chat door: a Writer that reports a cap or a missing key (a failed result, not a throw) leaves
// a failed task row with that reason as its summary and no artifact, and the refusal carries the same words to the loop.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { CommandContext } from '../define'
import { documentsDraft } from './workflows'

const CAP = 'The draft could not be written: Free models allow 5 drafts a day. Add credit or choose another way to run.'

vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({ userId: 'u1', isDemo: false }) }))
const writer = vi.hoisted(() => ({ runWriter: vi.fn() }))
vi.mock('@/lib/workflows/writer', () => writer)

const failed = { status: 'failed', error: CAP, fix: 'Tell the person this reason in one sentence. Do not try again.' }
beforeEach(() => writer.runWriter.mockReset().mockResolvedValue(failed))

describe('documents.draft when the Writer cannot write', () => {
  it('leaves a failed task row with the reason as its summary and no artifact', async () => {
    const db = makeFakeAdmin({ agent_tasks: [], artifacts: [] })
    const ctx = { door: 'chat', userId: 'u1', chat: { chatId: 'c1', turnId: 't1' }, admin: () => db } as unknown as CommandContext
    await expect(documentsDraft.run(ctx, { type: 'message', job_id: 'j1', instructions: 'ask about the timeline' })).rejects.toMatchObject({ name: 'CommandRefusal', status: 502, message: CAP })
    expect(db.tables.agent_tasks).toHaveLength(1)
    expect(db.tables.agent_tasks[0]).toMatchObject({ command: 'documents.draft', title: 'Writing a message', turn_id: 't1', status: 'failed', summary: CAP })
    expect(db.tables.artifacts).toHaveLength(0)
  })
})

describe('documents.draft when a call is replayed', () => {
  it('a replayed draft makes one draft: the Writer gets the call key', async () => {
    const db = makeFakeAdmin({ agent_tasks: [], artifacts: [{ id: 'art1', user_id: 'u1', title: 'Note', current_version: 1 }], artifact_versions: [{ artifact_id: 'art1', version: 1, content_text: 'Hello' }] })
    writer.runWriter.mockResolvedValue({ status: 'ok', artifact_id: 'art1', version: 1, title: 'Note', preview: 'Hello' })
    const ctx = { door: 'chat', userId: 'u1', callKey: 't1:call_1', chat: { chatId: 'c1', turnId: 't1' }, admin: () => db } as unknown as CommandContext
    const a = await documentsDraft.run(ctx, { type: 'note', job_id: 'j1' })
    const b = await documentsDraft.run(ctx, { type: 'note', job_id: 'j1' })
    expect(writer.runWriter.mock.calls.map((c) => (c[1] as { idempotency_key?: string }).idempotency_key)).toEqual(['t1:call_1', 't1:call_1'])
    expect(a.artifact_id).toBe('art1')
    expect(b.artifact_id).toBe('art1')
  })
})
