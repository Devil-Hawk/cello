// network.sync over a mocked Gmail and a recording database: who becomes a person, the alias, the cursor and
// the carry, and that none of it needs a model (nothing here sets a key or calls one).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const gmail = vi.hoisted(() => ({
  fetchGmailAddress: vi.fn(),
  fetchSendAs: vi.fn(),
  listThreadIds: vi.fn(),
  fetchThreadHeaders: vi.fn(),
}))
vi.mock('@/lib/gmail/gmail-api', () => gmail)

import { networkSync, THREADS_PER_TICK } from './sync'

type Row = Record<string, unknown>

/** A recording stand-in for the admin client: reads answer from `tables`, writes land in `log`. */
function fakeAdmin(tables: { messages?: Row[]; company_directory?: Row[] } = {}) {
  const log = { contacts: [] as Row[], messages: [] as Row[], ties: [] as Row[] }
  const admin = {
    from(table: string) {
      let write: { op: string; payload?: unknown } | null = null
      const q: Record<string, unknown> = {}
      const result = () => {
        if (table === 'contacts' && write?.op === 'insert') {
          const row = { ...(write.payload as Row), id: `c${log.contacts.length + 1}` }
          log.contacts.push(row)
          return { data: row, error: null }
        }
        if (table === 'messages' && write?.op === 'upsert') log.messages.push(...(write.payload as Row[]))
        if (table === 'contact_applications' && write?.op === 'upsert') log.ties.push(write.payload as Row)
        if (write) return { data: null, error: null }
        return { data: (tables as Record<string, Row[] | undefined>)[table] ?? [], error: null }
      }
      const chain = new Proxy(q, {
        get(_t, prop: string) {
          if (prop === 'then') return (res: (v: unknown) => unknown) => res(result())
          if (prop === 'maybeSingle') return () => Promise.resolve({ data: table === 'contacts' ? null : (result() as { data: Row[] }).data[0] ?? null, error: null })
          if (prop === 'single') return () => Promise.resolve(result())
          return (...args: unknown[]) => {
            if (prop === 'insert' || prop === 'upsert' || prop === 'update') write = { op: prop, payload: args[0] }
            return chain
          }
        },
      })
      return chain
    },
  }
  return { admin: admin as never, log }
}

const NOW = new Date('2026-10-06T12:00:00Z')
const at = (d: string) => String(new Date(d).getTime())
const msg = (id: string, from: string, to: string, date: string) => ({
  id,
  internalDate: at(date),
  headers: [
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: 'Staff engineer role' },
  ],
})
const thread = (id: string, ...messages: ReturnType<typeof msg>[]) => ({ id, messages })

beforeEach(() => {
  vi.resetAllMocks()
  gmail.fetchGmailAddress.mockResolvedValue('me@mail.test')
  gmail.fetchSendAs.mockResolvedValue(['alias@mail.test'])
})

const petrichor = [{ id: 'emp1', domain: 'petrichor.ai' }]
const run = (admin: never, previous = {}) => networkSync(admin, { userId: 'u1', accessToken: 't', previous, now: NOW })

describe('networkSync', () => {
  it('makes a person from a two-way thread at a verified employer domain, with a row for every message and no model', async () => {
    const { admin, log } = fakeAdmin({ company_directory: petrichor })
    gmail.listThreadIds.mockResolvedValue(['t1'])
    gmail.fetchThreadHeaders.mockResolvedValue(
      thread('t1', msg('m1', 'Me <me@mail.test>', 'Marcus Reed <marcus@petrichor.ai>', '2026-09-01T10:00:00Z'), msg('m2', 'Marcus Reed <marcus@petrichor.ai>', 'me@mail.test', '2026-09-02T10:00:00Z')),
    )
    const res = await run(admin)
    expect(res.people).toBe(1)
    expect(log.contacts[0]).toMatchObject({ email: 'marcus@petrichor.ai', name: 'Marcus Reed', source: 'gmail', address_kind: 'employer', employer_id: 'emp1' })
    expect(log.messages.map((m) => [m.gmail_message_id, m.direction, m.excerpt])).toEqual([
      ['m1', 'out', null],
      ['m2', 'in', null],
    ])
    expect(log.messages.every((m) => m.contact_id === 'c1')).toBe(true)
  })

  it('a friend on gmail.com makes no person and is counted as left out', async () => {
    const { admin, log } = fakeAdmin()
    gmail.listThreadIds.mockResolvedValue(['t1'])
    gmail.fetchThreadHeaders.mockResolvedValue(thread('t1', msg('m1', 'Me <me@mail.test>', 'Pat Friend <pat@gmail.com>', '2026-09-01T10:00:00Z'), msg('m2', 'Pat Friend <pat@gmail.com>', 'me@mail.test', '2026-09-02T10:00:00Z')))
    const res = await run(admin)
    expect(res.people).toBe(0)
    expect(log.contacts).toEqual([])
    expect(res.found.leftOut?.counts.not_human_mail).toBe(1)
  })

  it('counts an alias as you, so mail from it is an out row and never a person', async () => {
    const { admin, log } = fakeAdmin({ company_directory: petrichor })
    gmail.listThreadIds.mockResolvedValue(['t1'])
    gmail.fetchThreadHeaders.mockResolvedValue(
      thread('t1', msg('m1', 'Me <alias@mail.test>', 'Marcus Reed <marcus@petrichor.ai>', '2026-09-01T10:00:00Z'), msg('m2', 'Marcus Reed <marcus@petrichor.ai>', 'alias@mail.test', '2026-09-02T10:00:00Z')),
    )
    await run(admin)
    expect(log.contacts.map((c) => c.email)).toEqual(['marcus@petrichor.ai'])
    expect(log.messages[0]).toMatchObject({ gmail_message_id: 'm1', direction: 'out' })
  })

  it('moves the cursor when every listed thread was read, and keeps the ones that failed or did not fit for the next tick', async () => {
    const { admin } = fakeAdmin()
    const ids = Array.from({ length: THREADS_PER_TICK + 5 }, (_, i) => `t${i}`)
    gmail.listThreadIds.mockResolvedValue(ids)
    gmail.fetchThreadHeaders.mockImplementation(async (_t: string, id: string) => {
      if (id === 't3') throw new Error('429')
      return thread(id, msg(`${id}-m`, 'Pat Friend <pat@gmail.com>', 'me@mail.test', '2026-09-01T10:00:00Z'))
    })
    const first = await run(admin)
    expect(first.found.cursor).toBe(Math.floor(NOW.getTime() / 1000) - 60)
    expect(first.found.pending).toEqual(['t3', ...ids.slice(THREADS_PER_TICK)])

    gmail.listThreadIds.mockResolvedValue([])
    gmail.fetchThreadHeaders.mockImplementation(async (_t: string, id: string) => thread(id, msg(`${id}-m`, 'Pat Friend <pat@gmail.com>', 'me@mail.test', '2026-09-01T10:00:00Z')))
    const second = await run(admin, first.found)
    expect(second.found.pending).toEqual([])
    expect(gmail.fetchThreadHeaders).toHaveBeenCalledWith('t', 't3')
  })

  it('a thread Gmail says is gone is dropped, not retried', async () => {
    const { admin } = fakeAdmin()
    gmail.listThreadIds.mockResolvedValue(['gone'])
    gmail.fetchThreadHeaders.mockResolvedValue(null)
    const res = await run(admin)
    expect(res.found.pending).toEqual([])
  })

  it('a failed listing throws, so the cursor and the carry are not written', async () => {
    const { admin } = fakeAdmin()
    gmail.listThreadIds.mockRejectedValue(new Error('503'))
    await expect(run(admin, { cursor: 5, pending: ['x'] })).rejects.toThrow('503')
  })
})
