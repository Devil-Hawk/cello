// A message's text lives on an artifact version (K17): written first, linked from the row, changed
// by adding a version, and read back from it. The approval payload carries the address and
// whether it is someone new. Runs against a fake store that keeps artifacts, not a mock of them.

import { describe, expect, it, vi } from 'vitest'
import { artifactWorld } from '@/lib/artifacts/testing'
import { getOutreach, insertOutreach, isNewRecipient, updateOutreach } from './store'

vi.mock('../interactions/store', () => ({ recordInteraction: vi.fn() }))

const draft = { user_id: 'u1', to_email: 'dana@example.com', to_name: 'Dana', subject: 'Hello', body: 'Hi Dana, a short note.', kind: 'initial' as const, contact_id: 'c1', job_id: 'j1', company_id: 'co1' }

describe('insertOutreach writes the artifact first', () => {
  it('makes a message artifact with the text, and the row points at its version and mirrors the text', async () => {
    const { admin, client } = artifactWorld()
    const row = await insertOutreach(client, draft)
    expect(admin.tables.artifacts).toHaveLength(1)
    expect(admin.tables.artifacts[0]).toMatchObject({ user_id: 'u1', type: 'message', job_id: 'j1', company_id: 'co1', contact_id: 'c1' })
    expect(admin.tables.artifact_versions[0]).toMatchObject({ version: 1, author: 'cello' })
    expect(admin.tables.artifact_versions[0].content_text).toBe('To: Dana <dana@example.com>\nSubject: Hello\n\nHi Dana, a short note.')
    expect(row).toMatchObject({ artifact_id: admin.tables.artifacts[0].id, artifact_version: 1, subject: 'Hello', body: 'Hi Dana, a short note.' })
    expect((admin.tables.artifact_versions[0].content as { outreach_id: string }).outreach_id).toBe(row.id)
  })

  it('reuses the artifact a draft was queued from instead of making a second', async () => {
    const { admin, client } = artifactWorld()
    await insertOutreach(client, { ...draft, artifact_id: 'queued-artifact', artifact_version: 3 })
    expect(admin.tables.artifacts ?? []).toHaveLength(0)
    expect(admin.tables.outreach_messages[0]).toMatchObject({ artifact_id: 'queued-artifact', artifact_version: 3 })
  })

  it('removes the artifact when the row cannot be saved, and still raises the row error with its code', async () => {
    const { admin, client } = artifactWorld()
    const real = admin.from.bind(admin)
    ;(admin as { from: unknown }).from = (name: string) => {
      if (name !== 'outreach_messages') return real(name)
      const b = real(name) as unknown as { insert: () => unknown }
      b.insert = () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'duplicate key value', code: '23505' } }) }) })
      return b
    }
    const err = await insertOutreach(client, draft).catch((e) => e)
    expect(err).toMatchObject({ code: '23505' })
    expect(admin.tables.artifacts).toHaveLength(0)
  })
})

describe('reading and changing the text', () => {
  it('reads the text from the version the row points at', async () => {
    const { admin, client } = artifactWorld()
    const row = await insertOutreach(client, draft)
    // The version holds the words; the row's columns are the fallback.
    ;(admin.tables.artifact_versions[0].content as { body: string }).body = 'Rewritten on the version.'
    expect((await getOutreach(client, 'u1', row.id))?.body).toBe('Rewritten on the version.')
  })

  it('falls back to the row for a message from before the copy', async () => {
    const { client } = artifactWorld({ outreach_messages: [{ id: 'old', user_id: 'u1', subject: 'Old', body: 'Old body', artifact_id: null, artifact_version: null }] })
    expect(await getOutreach(client, 'u1', 'old')).toMatchObject({ subject: 'Old', body: 'Old body' })
  })

  it('a change to the body adds a version first, then the row follows it', async () => {
    const { admin, client } = artifactWorld()
    const row = await insertOutreach(client, draft)
    const updated = await updateOutreach(client, 'u1', row.id, { body: 'A better note.' })
    expect(admin.tables.artifact_versions).toHaveLength(2)
    expect(admin.tables.artifact_versions[1]).toMatchObject({ version: 2, author: 'user' })
    expect(admin.tables.artifact_versions[1].content_text).toContain('A better note.')
    expect(updated).toMatchObject({ body: 'A better note.', subject: 'Hello', artifact_version: 2 })
  })

  it('a change that is not text adds no version', async () => {
    const { admin, client } = artifactWorld()
    const row = await insertOutreach(client, draft)
    await updateOutreach(client, 'u1', row.id, { status: 'approved' })
    expect(admin.tables.artifact_versions).toHaveLength(1)
  })

  it('a row never linked gets its artifact when its text first changes', async () => {
    const { admin, client } = artifactWorld({ outreach_messages: [{ id: 'old', user_id: 'u1', to_email: 'a@b.com', to_name: null, subject: 'Old', body: 'Old body', kind: 'initial', job_id: null, company_id: null, contact_id: null, artifact_id: null }] })
    const updated = await updateOutreach(client, 'u1', 'old', { body: 'New body' })
    expect(admin.tables.artifacts).toHaveLength(1)
    expect(updated).toMatchObject({ artifact_id: admin.tables.artifacts[0].id, artifact_version: 1, body: 'New body' })
  })
})

describe('isNewRecipient', () => {
  it('is true for an address nothing was sent to, and false once something was sent', async () => {
    const { client } = artifactWorld({ outreach_messages: [{ id: 'm1', user_id: 'u1', to_email: 'Dana@Example.com', status: 'sent' }, { id: 'm2', user_id: 'u1', to_email: 'pending@example.com', status: 'pending_review' }, { id: 'm3', user_id: 'u2', to_email: 'other@example.com', status: 'sent' }] })
    expect(await isNewRecipient(client, 'u1', 'new@example.com')).toBe(true)
    expect(await isNewRecipient(client, 'u1', 'pending@example.com')).toBe(true)
    expect(await isNewRecipient(client, 'u1', 'dana@example.com')).toBe(false)
    expect(await isNewRecipient(client, 'u1', 'other@example.com')).toBe(true)
  })
})
