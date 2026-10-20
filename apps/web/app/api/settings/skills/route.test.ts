// /api/settings/skills: the skills page's engine. What this file has to prove:
//   1. Only a signed-in session reaches it, and a demo cannot write.
//   2. A pasted skill is stored with its name and description only (allowed-tools never reaches the database).
//   3. Everything is scoped to the caller: PATCH and DELETE touch only the caller's own row, GET lists only theirs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeAdmin, type FakeAdmin } from '@/lib/agents/testing/fake-admin'

interface State {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  admin: FakeAdmin
}

let state: State

const makeAdmin = (rows: Record<string, unknown>[] = []) => makeFakeAdmin({ person_skills: rows }, { person_skills: { unique: [['user_id', 'name']], defaults: () => ({ enabled: true, updated_at: 'now' }) } })

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: () => {
    const self: Record<string, unknown> = { select: () => self, eq: () => self, maybeSingle: async () => ({ data: state.profile, error: null }) }
    return self
  },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => state.admin }))

import { DELETE, GET, PATCH, POST } from './route'

const req = (method: string, body?: unknown, query = '') =>
  new NextRequest(`http://localhost/api/settings/skills${query}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

const FILE = '---\nname: weekly-note\ndescription: Write a weekly note.\nallowed-tools: send_email\n---\n\n# Weekly note\nWrite it on Fridays.'

beforeEach(() => {
  state = { user: { id: 'u1' }, profile: { is_demo: false, demo_expires_at: null }, admin: makeAdmin() }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('signed out', () => {
  it('answers 401 on every verb and touches nothing', async () => {
    state.user = null
    for (const res of [await GET(), await POST(req('POST', { markdown: FILE })), await PATCH(req('PATCH', { id: 'x', enabled: false })), await DELETE(req('DELETE', undefined, '?id=x'))]) expect(res.status).toBe(401)
    expect(state.admin.log).toEqual([])
  })
})

describe('POST', () => {
  it('saves a pasted skill with allowed-tools gone', async () => {
    const res = await POST(req('POST', { markdown: FILE }))
    expect(res.status).toBe(200)
    const { skill } = await res.json()
    expect(skill).toMatchObject({ name: 'weekly-note', description: 'Write a weekly note.', source: 'Pasted', enabled: true })
    expect(skill).not.toHaveProperty('body')
    const [row] = state.admin.tables.person_skills
    expect(row).toMatchObject({ user_id: 'u1', name: 'weekly-note', body: '# Weekly note\nWrite it on Fridays.' })
    expect(JSON.stringify(row)).not.toContain('allowed-tools')
  })

  it('joins references into the body and names a folder as the source', async () => {
    const res = await POST(req('POST', { markdown: FILE, folder: 'my-folder', references: [{ path: 'references/a.md', text: 'Ref A' }] }))
    expect((await res.json()).skill.source).toBe('Folder: my-folder')
    expect(state.admin.tables.person_skills[0].body).toBe('# Weekly note\nWrite it on Fridays.\n\n---\n\n## references/a.md\n\nRef A')
    const long = await POST(req('POST', { markdown: FILE.replace('weekly-note', 'other'), folder: 'f'.repeat(300) }))
    expect((await long.json()).skill.source).toBe(`Folder: ${'f'.repeat(100)}`)
  })

  it('answers 400 with the parse copy', async () => {
    const res = await POST(req('POST', { markdown: '# nothing' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'bad_request',
      message: 'That file has no name and description at the top.',
      fix: 'Start it with a line of three dashes, then name: and description: lines, then three dashes.',
    })
    expect(state.admin.tables.person_skills).toHaveLength(0)
  })

  it('refuses more than 200,000 characters in total, references included', async () => {
    const res = await POST(req('POST', { markdown: FILE, references: [{ path: 'references/big.md', text: 'x'.repeat(200_000) }] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_request', message: 'That is more than 200 KB.', fix: 'Remove some files and try again.' })
    expect(state.admin.tables.person_skills).toHaveLength(0)
  })

  it('answers 409 for a name the person already has', async () => {
    await POST(req('POST', { markdown: FILE }))
    const res = await POST(req('POST', { markdown: FILE }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'exists', message: 'You already have a skill named weekly-note.', fix: 'Delete it first, or change the name in the file.' })
    expect(state.admin.tables.person_skills).toHaveLength(1)
  })

  it('lets two people use the same name', async () => {
    state.admin = makeAdmin([{ id: 'a', user_id: 'u2', name: 'weekly-note', description: 'Theirs', body: 'b', source: 'Pasted' }])
    expect((await POST(req('POST', { markdown: FILE }))).status).toBe(200)
  })
})

describe('a demo', () => {
  it('is refused on every write and nothing is written', async () => {
    state.profile = { is_demo: true, demo_expires_at: null }
    state.admin = makeAdmin([{ id: 'a', user_id: 'u1', name: 'x', description: 'd', body: 'b', source: 'Pasted' }])
    const want = { error: 'demo', message: 'A demo account cannot add skills.', fix: 'Sign up to add your own.' }
    for (const res of [await POST(req('POST', { markdown: FILE })), await PATCH(req('PATCH', { id: 'a', enabled: false })), await DELETE(req('DELETE', undefined, '?id=a'))]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual(want)
    }
    expect(state.admin.log).toEqual([])
    expect(state.admin.tables.person_skills[0].enabled).toBeUndefined()
  })

  it('is refused when the profile cannot be read', async () => {
    state.profile = null
    expect((await POST(req('POST', { markdown: FILE }))).status).toBe(403)
    expect(state.admin.log).toEqual([])
  })

  it('can still read', async () => {
    state.profile = { is_demo: true, demo_expires_at: null }
    expect((await GET()).status).toBe(200)
  })
})

describe('PATCH and DELETE', () => {
  const rows = () => [
    { id: 'mine', user_id: 'u1', name: 'weekly-note', description: 'Write a weekly note.', body: 'b', source: 'Pasted', enabled: true, created_at: '2026-10-01T00:00:00Z' },
    { id: 'theirs', user_id: 'u2', name: 'weekly-note', description: 'Theirs.', body: 'b', source: 'Pasted', enabled: true, created_at: '2026-10-01T00:00:00Z' },
  ]

  it('toggles a skill on and off', async () => {
    state.admin = makeAdmin(rows())
    const res = await PATCH(req('PATCH', { id: 'mine', enabled: false }))
    expect(res.status).toBe(200)
    expect((await res.json()).skill).toMatchObject({ id: 'mine', enabled: false })
    expect(state.admin.tables.person_skills[0].enabled).toBe(false)
    expect(state.admin.tables.person_skills[1].enabled).toBe(true)
  })

  it('answers 404 for an unknown id and for another person\'s skill, and changes nothing', async () => {
    state.admin = makeAdmin(rows())
    for (const res of [await PATCH(req('PATCH', { id: 'nope', enabled: false })), await PATCH(req('PATCH', { id: 'theirs', enabled: false })), await DELETE(req('DELETE', undefined, '?id=theirs')), await DELETE(req('DELETE', undefined, '?id=nope'))]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found', message: 'That skill was not found.' })
    }
    expect(state.admin.tables.person_skills).toHaveLength(2)
    expect(state.admin.tables.person_skills[1].enabled).toBe(true)
  })

  it('refuses a toggle without a true or false', async () => {
    expect((await PATCH(req('PATCH', { id: 'mine', enabled: 'no' }))).status).toBe(400)
  })

  it('deletes only the person\'s own row', async () => {
    state.admin = makeAdmin(rows())
    const res = await DELETE(req('DELETE', undefined, '?id=mine'))
    expect(await res.json()).toEqual({ ok: true })
    expect(state.admin.tables.person_skills.map((r) => r.id)).toEqual(['theirs'])
  })
})

describe('GET', () => {
  it("lists Cello's skills with their state and the person's own without bodies", async () => {
    state.admin = makeAdmin([
      { id: 'mine', user_id: 'u1', name: 'weekly-note', description: 'Write a weekly note.', body: 'secret body', source: 'Pasted', enabled: false, created_at: '2026-10-01T00:00:00Z' },
      { id: 'theirs', user_id: 'u2', name: 'other', description: 'Theirs.', body: 'b', source: 'Pasted', enabled: true, created_at: '2026-10-01T00:00:00Z' },
    ])
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.mine).toEqual([{ id: 'mine', name: 'weekly-note', description: 'Write a weekly note.', source: 'Pasted', enabled: false, created_at: '2026-10-01T00:00:00Z' }])
    expect(JSON.stringify(json)).not.toContain('secret body')
    expect(json.cello.map((s: { name: string }) => s.name)).toEqual(['find-roles', 'company-research', 'tailor-resume', 'answer-questions', 'cold-outreach', 'follow-up', 'compare-roles', 'board-reader'])
    for (const s of json.cello) expect(Object.keys(s.tiers).sort()).toEqual(['free', 'local', 'paid'])
  })
})
