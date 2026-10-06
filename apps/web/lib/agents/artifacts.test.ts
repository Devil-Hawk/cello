import { describe, expect, it } from 'vitest'
import {
  addVersion,
  artifactIdFromPath,
  artifactPath,
  createArtifact,
  editDistanceRatio,
  getArtifact,
  listArtifacts,
  listVersions,
  parseContent,
  renderMarkdown,
  slug,
} from './artifacts'
import { makeFakeAdmin, type FakeAdmin } from './testing/fake-admin'

/** The SQL function artifact_add_version, in JS. supabase/checks/agent_engine.sql proves the real one. */
function admin(): FakeAdmin {
  const a = makeFakeAdmin({}, { artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) } })
  a.rpcHandlers.artifact_add_version = async (args) => {
    const art = a.tables.artifacts.find((r) => r.id === args.p_artifact_id && r.user_id === args.p_user_id)
    if (!art) throw new Error('artifact not found for this user')
    const next = (art.current_version as number) + 1
    art.current_version = next
    a.tables.artifact_versions.push({
      artifact_id: art.id,
      version: next,
      author: args.p_author,
      content: args.p_content,
      content_text: args.p_content_text,
    })
    return next
  }
  return a
}

const letter = { text: 'Dear team,\nI built a billing system at Acme.' }

describe('createArtifact', () => {
  it('creates the artifact with version 1 and readable text', async () => {
    const a = admin()
    const ref = await createArtifact(a, { userId: 'u1', type: 'cover_letter', title: 'Letter for Stripe', content: letter, author: 'cello' })
    expect(ref).toMatchObject({ version: 1, created: true })
    const got = await getArtifact(a, 'u1', ref.id)
    expect(got?.version.content_text).toBe(letter.text)
    expect(got?.version.author).toBe('cello')
  })

  it('a second call with the same key returns the first artifact', async () => {
    const a = admin()
    const input = { userId: 'u1', type: 'cover_letter' as const, title: 'Letter', content: letter, author: 'cello' as const, idempotencyKey: 'thread:call-1' }
    const first = await createArtifact(a, input)
    const second = await createArtifact(a, input)
    expect(second).toEqual({ id: first.id, version: 1, created: false })
    expect(a.tables.artifacts).toHaveLength(1)
    expect(a.tables.artifact_versions).toHaveLength(1)
  })

  it('two calls at once with one key make one artifact', async () => {
    const a = admin()
    const input = { userId: 'u1', type: 'cover_letter' as const, title: 'Letter', content: letter, author: 'cello' as const, idempotencyKey: 'k' }
    const [x, y] = await Promise.all([createArtifact(a, input), createArtifact(a, input)])
    expect(x.id).toBe(y.id)
    expect(a.tables.artifacts).toHaveLength(1)
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1)
  })

  it('refuses content that does not fit the type', async () => {
    await expect(
      createArtifact(admin(), { userId: 'u1', type: 'message', title: 'x', content: { body: 'no subject' }, author: 'cello' })
    ).rejects.toThrow()
  })

  it('keeps nothing when the version row cannot be written', async () => {
    const a = admin()
    const real = a.from.bind(a)
    ;(a as unknown as { from: (t: string) => unknown }).from = (t: string) =>
      t === 'artifact_versions' ? { insert: () => Promise.resolve({ data: null, error: { message: 'disk full' } }) } : real(t)
    await expect(createArtifact(a, { userId: 'u1', type: 'cover_letter', title: 'x', content: letter, author: 'cello' })).rejects.toThrow('disk full')
    expect(a.tables.artifacts ?? []).toHaveLength(0)
  })
})

describe('addVersion', () => {
  it('adds the next version and records who made it', async () => {
    const a = admin()
    const { id } = await createArtifact(a, { userId: 'u1', type: 'cover_letter', title: 'Letter', content: letter, author: 'cello' })
    const v = await addVersion(a, { userId: 'u1', artifactId: id, author: 'user', content: { text: 'Edited by me.' } })
    expect(v).toBe(2)
    const versions = await listVersions(a, 'u1', id)
    expect(versions.map((x) => [x.version, x.author])).toEqual([
      [2, 'user'],
      [1, 'cello'],
    ])
    expect((await getArtifact(a, 'u1', id))?.version.content_text).toBe('Edited by me.')
    expect((await getArtifact(a, 'u1', id, { version: 1 }))?.version.content_text).toBe(letter.text)
  })

  it("will not touch another user's artifact", async () => {
    const a = admin()
    const { id } = await createArtifact(a, { userId: 'u1', type: 'cover_letter', title: 'Letter', content: letter, author: 'cello' })
    await expect(addVersion(a, { userId: 'u2', artifactId: id, author: 'user', content: { text: 'mine now' } })).rejects.toThrow(/No artifact/)
    expect(await getArtifact(a, 'u2', id)).toBeNull()
    expect(await listVersions(a, 'u2', id)).toEqual([])
  })
})

describe('listArtifacts', () => {
  it('filters by type and user and returns the newest first', async () => {
    const a = admin()
    await createArtifact(a, { userId: 'u1', type: 'cover_letter', title: 'A', content: letter, author: 'cello' })
    await createArtifact(a, { userId: 'u1', type: 'resume', title: 'B', content: { text: 'r' }, author: 'cello' })
    await createArtifact(a, { userId: 'u2', type: 'resume', title: 'C', content: { text: 'r' }, author: 'cello' })
    expect((await listArtifacts(a, 'u1')).map((r) => r.title).sort()).toEqual(['A', 'B'])
    expect((await listArtifacts(a, 'u1', { type: 'resume' })).map((r) => r.title)).toEqual(['B'])
  })
})

describe('rendering and paths', () => {
  it('renders each type as readable text', () => {
    expect(renderMarkdown('message', { subject: 'Hello', body: 'Body', to_name: 'Dana Lee', to_email: 'dana@x.com' })).toBe(
      'To: Dana Lee <dana@x.com>\nSubject: Hello\n\nBody'
    )
    const shortlist = renderMarkdown('shortlist', {
      items: [{ job_id: 'j1', title: 'PM', company: 'Stripe', reason: 'You shipped payments.', chance: 'strong', gaps: [], exploration: false }],
      generated_at: '2026-10-05',
    })
    expect(shortlist).toContain('PM at Stripe [strong]: You shipped payments. (id j1)')
    expect(renderMarkdown('research', { company: 'Stripe', summary: null, sources: [] })).toContain('No summary yet')
  })

  it('maps an artifact to a path and back', () => {
    const row = { id: '11111111-2222-3333-4444-555555555555', type: 'cover_letter', title: 'Letter for Stripe, PM!' }
    const p = artifactPath(row)
    expect(p).toBe('/artifacts/cover_letter/letter-for-stripe-pm-11111111-2222-3333-4444-555555555555.md')
    expect(artifactIdFromPath(p)).toBe(row.id)
    expect(artifactIdFromPath('/memories/x.md')).toBeNull()
    expect(slug('!!!')).toBe('untitled')
  })

  it('measures how much an edit changed a draft', () => {
    expect(editDistanceRatio('same', 'same')).toBe(0)
    expect(editDistanceRatio('abcd', 'abcf')).toBeCloseTo(0.25)
    expect(editDistanceRatio('abc', 'xyz')).toBe(1)
  })

  it('parseContent fills defaults', () => {
    expect(parseContent('research', { company: 'Stripe', summary: null }).sources).toEqual([])
  })
})
