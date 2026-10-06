import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { activeTiles, attach, CELLO_ATTACHES_PER_TURN, detach, ledgerKey, refFromId, type AttachBy } from './attach'
import { refId, type ObjectReader } from './types'

// attach's default reader is the stub, which loads the scoring module; every test here passes its own reader.
vi.mock('./objects', () => ({ getObject: vi.fn() }))

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CHAT = uuid(900)
const person: AttachBy = { origin: 'person', door: 'chat.attach' }

/** Everything the person owns reads; everything else reads as not found, as a get command under RLS does. */
const reader =
  (owned: string[]): ObjectReader =>
  async (_db, userId, kind, ref) =>
    userId === 'u1' && owned.includes(`${kind}:${refId(kind, ref)}`)
      ? { kind, id: refId(kind, ref), title: 'A thing', company: null, facts: [], body: null }
      : null

const setup = (extra: Record<string, unknown>[] = []) =>
  makeFakeAdmin({
    chats: [
      { id: CHAT, user_id: 'u1' },
      { id: uuid(901), user_id: 'u2' },
    ],
    chat_attachments: extra,
  })

describe('an application tile and its group', () => {
  const app = (n: number) => ({ id: uuid(n), user_id: 'u1', stage: 'applied', applied_at: null, jobs: { title: `Role ${n}`, companies: { name: 'Co' } } })
  const seed = () => makeFakeAdmin({ chats: [{ id: CHAT, user_id: 'u1', project_id: null }], chat_attachments: [], applications: [app(1), app(2)], projects: [] }, { projects: { unique: [['application_id']] } })
  const read: ObjectReader = async (_db, _u, kind, ref) => ({ kind, id: refId(kind, ref), title: 'Role', company: 'Co', facts: [], body: null })

  it('puts a chat about one application in that application\'s group, and takes it out when a second is added', async () => {
    const db = seed()
    expect(await attach(db, 'u1', CHAT, { kind: 'application', ref: { id: uuid(1) } }, person, read)).toMatchObject({ ok: true })
    expect(db.tables.projects).toHaveLength(1)
    expect(db.tables.chats[0].project_id).toBe(db.tables.projects[0].id)
    expect(await attach(db, 'u1', CHAT, { kind: 'application', ref: { id: uuid(2) } }, person, read)).toMatchObject({ ok: true })
    expect(db.tables.chats[0].project_id).toBeNull()
  })
})

describe('attach', () => {
  it('holds the person\'s own thing and records the door', async () => {
    const db = setup()
    const out = await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(1) } }, person, reader([`role:${uuid(1)}`]))
    expect(out).toMatchObject({ ok: true, already: false })
    expect(db.tables.chat_attachments).toHaveLength(1)
    expect(db.tables.chat_attachments[0]).toMatchObject({ kind: 'role', origin: 'person', prov: { door: 'chat.attach' } })
  })

  it('refuses another person\'s role, chat or made thing, and a chat that is not theirs', async () => {
    const db = setup()
    const get = reader([])
    for (const [kind, ref] of [
      ['role', { id: uuid(1) }],
      ['chat', { chat_id: uuid(2) }],
      ['made', { table: 'artifacts', id: uuid(3) }],
    ] as const) {
      expect(await attach(db, 'u1', CHAT, { kind, ref }, person, get)).toMatchObject({ ok: false })
    }
    expect(await attach(db, 'u1', uuid(901), { kind: 'role', ref: { id: uuid(1) } }, person, reader([`role:${uuid(1)}`]))).toMatchObject({ ok: false })
    expect(db.log.some((l) => l.startsWith('insert'))).toBe(false)
  })

  it('refuses a forged ref: extra keys, a malformed id, a table that is not artifacts, an unknown kind', async () => {
    const db = setup()
    const get = reader([`role:${uuid(1)}`, `made:${uuid(1)}`, 'role:x'])
    const bad: [string, unknown][] = [
      ['role', { id: uuid(1), user_id: 'u2' }],
      ['role', { id: 'x' }],
      ['role', 'not an object'],
      ['made', { table: 'profiles', id: uuid(1) }],
      ['chat', { id: uuid(1) }],
      ['project', { id: uuid(1) }],
    ]
    for (const [kind, ref] of bad) expect(await attach(db, 'u1', CHAT, { kind, ref }, person, get)).toMatchObject({ ok: false })
    expect(db.tables.chat_attachments ?? []).toHaveLength(0)
  })

  it('holds a thing once: a second attach returns the first tile', async () => {
    const db = setup()
    const get = reader([`company:${uuid(5)}`])
    const first = await attach(db, 'u1', CHAT, { kind: 'company', ref: { id: uuid(5) } }, person, get)
    const again = await attach(db, 'u1', CHAT, { kind: 'company', ref: { id: uuid(5) } }, person, get)
    expect(again).toMatchObject({ ok: true, already: true })
    expect(db.tables.chat_attachments).toHaveLength(1)
    expect(first.ok && again.ok && first.attachment.id === again.attachment.id).toBe(true)
  })

  it('refuses the 26th tile in words', async () => {
    const full = Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, user_id: 'u1', chat_id: CHAT, kind: 'role', ref: { id: uuid(i + 10) }, position: i + 1, removed_at: null }))
    const db = setup(full)
    const out = await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(99) } }, person, reader([`role:${uuid(99)}`]))
    expect(out).toMatchObject({ ok: false, error: 'This chat already holds 25 things.' })
  })
})

describe('Cello attaches', () => {
  const turn = (ids: number[], turnId = 't1'): AttachBy => ({ origin: 'model', turnId, returned: new Set(ids.map((n) => ledgerKey('role', uuid(n)))) })
  const get = reader(Array.from({ length: 20 }, (_, i) => `role:${uuid(i + 1)}`))

  it('only what a tool returned this turn, with the turn on its provenance', async () => {
    const db = setup()
    expect(await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(2) } }, turn([1]), get)).toMatchObject({ ok: false })
    expect(await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(1) } }, turn([1]), get)).toMatchObject({ ok: true })
    expect(db.tables.chat_attachments[0]).toMatchObject({ origin: 'model', prov: { turn_id: 't1' } })
  })

  it('at most 12 in a turn, and the next turn starts again', async () => {
    const db = setup()
    const ids = Array.from({ length: 14 }, (_, i) => i + 1)
    const results = []
    for (const n of ids) results.push(await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(n) } }, turn(ids), get))
    expect(results.filter((r) => r.ok)).toHaveLength(CELLO_ATTACHES_PER_TURN)
    expect(await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(14) } }, turn(ids, 't2'), get)).toMatchObject({ ok: true })
  })
})

describe('detach', () => {
  it('keeps the row, drops the tile from the active list, and frees the place', async () => {
    const db = setup()
    const get = reader([`role:${uuid(1)}`])
    const out = await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(1) } }, person, get)
    if (!out.ok) throw new Error('attach failed')
    expect(await detach(db, 'u1', CHAT, out.attachment.id)).toEqual({ ok: true })
    expect(db.tables.chat_attachments).toHaveLength(1)
    expect(db.tables.chat_attachments[0].removed_at).not.toBeNull()
    expect(await activeTiles(db, 'u1', CHAT)).toEqual([])
    // The same thing can come back as a new row.
    expect(await attach(db, 'u1', CHAT, { kind: 'role', ref: { id: uuid(1) } }, person, get)).toMatchObject({ ok: true, already: false })
    expect(db.tables.chat_attachments).toHaveLength(2)
  })

  it('refuses another person\'s tile', async () => {
    const db = setup([{ id: 'a1', user_id: 'u2', chat_id: uuid(901), kind: 'role', ref: { id: uuid(1) }, position: 1, removed_at: null }])
    expect(await detach(db, 'u1', uuid(901), 'a1')).toMatchObject({ ok: false })
    expect(db.tables.chat_attachments[0].removed_at).toBeNull()
  })
})

describe('refFromId', () => {
  it('builds the stored ref for a kind and its id, and refuses anything a chat cannot hold', () => {
    expect(refFromId('role', uuid(1))).toEqual({ id: uuid(1) })
    expect(refFromId('chat', uuid(2))).toEqual({ chat_id: uuid(2) })
    expect(refFromId('made', uuid(3))).toEqual({ table: 'artifacts', id: uuid(3) })
    expect(refFromId('preview', uuid(4))).toBeNull()
    expect(refFromId('role', 'not-an-id')).toBeNull()
    expect(refFromId('project', uuid(5))).toBeNull()
  })
})
