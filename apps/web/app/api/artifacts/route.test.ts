// /api/artifacts and /api/artifacts/[id]: the persons own saved documents and their edits.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createArtifact } from '@/lib/agents/artifacts'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

const state = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, admin: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => state.admin }))
vi.mock('@/lib/observability/langfuse', () => ({ scoreTrace: async () => undefined }))

import { GET as list } from './route'
import { GET as one, POST as edit } from './[id]/route'

let admin: FakeAdmin
beforeEach(() => {
  state.user = { id: 'u1' }
  admin = makeFakeAdmin(
    {},
    { artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) } }
  )
  admin.rpcHandlers.artifact_add_version = async (args) => {
    const art = admin.tables.artifacts.find((r) => r.id === args.p_artifact_id && r.user_id === args.p_user_id)!
    art.current_version = (art.current_version as number) + 1
    admin.tables.artifact_versions.push({ artifact_id: art.id, version: art.current_version, author: args.p_author, content: args.p_content, content_text: args.p_content_text, created_at: new Date().toISOString() })
    return art.current_version
  }
  state.admin = admin
})

const get = (url: string) => new NextRequest(`http://localhost${url}`)
const post = (body: unknown) => new NextRequest('http://localhost/api/artifacts/x', { method: 'POST', body: JSON.stringify(body) })

describe('GET /api/artifacts', () => {
  it('lists only the persons own documents, filtered by type', async () => {
    await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Mine', content: { text: 'a' }, author: 'cello' })
    await createArtifact(admin, { userId: 'u1', type: 'resume', title: 'Resume', content: { text: 'b' }, author: 'cello' })
    await createArtifact(admin, { userId: 'u2', type: 'cover_letter', title: 'Theirs', content: { text: 'c' }, author: 'cello' })
    const all = (await (await list(get('/api/artifacts'))).json()).artifacts
    expect(all.map((a: { title: string }) => a.title).sort()).toEqual(['Mine', 'Resume'])
    const letters = (await (await list(get('/api/artifacts?type=cover_letter'))).json()).artifacts
    expect(letters.map((a: { title: string }) => a.title)).toEqual(['Mine'])
  })

  it('refuses an unknown type, and needs a signed in person', async () => {
    expect((await list(get('/api/artifacts?type=poem'))).status).toBe(400)
    state.user = null
    expect((await list(get('/api/artifacts'))).status).toBe(401)
  })
})

describe('GET and POST /api/artifacts/[id]', () => {
  it('shows every version with who wrote it, newest first, and saves an edit as the person', async () => {
    const a = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Letter', content: { text: 'First draft.' }, author: 'cello' })
    const saved = await edit(post({ content: { text: 'Second draft by me.' } }), { params: { id: a.id } })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toEqual({ version: 2 })
    const body = await (await one(get(`/api/artifacts/${a.id}`), { params: { id: a.id } })).json()
    expect(body.artifact.id).toBe(a.id)
    expect(body.versions.map((v: { version: number; author: string }) => [v.version, v.author])).toEqual([[2, 'user'], [1, 'cello']])
  })

  it("someone else's document and a missing one are the same 404; a body of the wrong kind is a 400 that adds nothing", async () => {
    const a = await createArtifact(admin, { userId: 'u2', type: 'cover_letter', title: 'Theirs', content: { text: 'x' }, author: 'cello' })
    expect((await one(get('/x'), { params: { id: a.id } })).status).toBe(404)
    expect((await edit(post({ content: { text: 'mine now' } }), { params: { id: a.id } })).status).toBe(404)
    const mine = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'Mine', content: { text: 'x' }, author: 'cello' })
    expect((await edit(post({ content: { nonsense: 1 } }), { params: { id: mine.id } })).status).toBe(400)
    expect((await edit(post({}), { params: { id: mine.id } })).status).toBe(400)
    expect(admin.tables.artifact_versions.filter((v) => v.artifact_id === mine.id)).toHaveLength(1)
  })
})
