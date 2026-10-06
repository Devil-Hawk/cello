// Delivery: told once, outside quiet hours, to the person's own inbox, never with the other side's words.

import { describe, expect, it, vi } from 'vitest'
import { alertText, sendAlert, sendSummary, type Deliver } from './deliver'

type Row = Record<string, any>

function fakeAdmin(tables: Record<string, Row[]>): any {
  const unique: Record<string, string[]> = { notification_log: ['user_id', 'kind', 'subject_id'] }
  return {
    from(name: string) {
      tables[name] ??= []
      let rows = [...tables[name]]
      let mode: 'select' | 'insert' | 'delete' = 'select'
      let payload: Row = {}
      const filters: ((r: Row) => boolean)[] = []
      const run = () => {
        if (mode === 'insert') {
          const u = unique[name]
          if (u && tables[name].some((r) => u.every((c) => r[c] === payload[c]))) return { data: null, error: { code: '23505' } }
          tables[name].push({ sent_at: new Date('2026-10-14T12:00:00Z').toISOString(), ...payload })
          return { data: null, error: null }
        }
        if (mode === 'delete') {
          tables[name] = tables[name].filter((r) => !filters.every((f) => f(r)))
          return { data: null, error: null }
        }
        return { data: rows.filter((r) => filters.every((f) => f(r))), error: null }
      }
      const q: any = {
        select: () => q,
        insert: (v: Row) => ((mode = 'insert'), (payload = v), q),
        delete: () => ((mode = 'delete'), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        not: (c: string, _o: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), q),
        gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: (run().data as Row[] | null)?.[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res(run()),
      }
      return q
    },
  }
}

const U = 'u1'
// 14:00 UTC: outside the default quiet hours of 21:00 to 08:00
const DAY = new Date('2026-10-14T14:00:00Z')
const NIGHT = new Date('2026-10-14T23:30:00Z')

const base = (over: Row = {}): Record<string, Row[]> => ({
  profiles: [{ id: U, preferences: { pipeline: { summary: true } }, is_demo: false, demo_expires_at: null, ...over }],
  routines: [],
  applications: [],
  messages: [],
  pipeline_events: [
    { user_id: U, kind: 'submission.sent', actor: 'extension', trust: 'proven', company_name: 'Acme', created_at: '2026-10-14T05:00:00Z' },
    { user_id: U, kind: 'submission.sent', actor: 'extension', trust: 'proven', company_name: 'Stripe', created_at: '2026-10-14T05:10:00Z' },
    { user_id: U, kind: 'fill.blocked', actor: 'extension', trust: 'proven', company_name: 'Amazon', created_at: '2026-10-14T05:20:00Z' },
    { user_id: U, kind: 'submission.unconfirmed', actor: 'extension', trust: 'proven', company_name: 'Ramp', created_at: '2026-10-14T05:30:00Z' },
  ],
  notification_log: [],
  push_subscriptions: [],
})

const deliver = (tables: Record<string, Row[]>, now = DAY, sent: string[] = [], result: 'sent' | 'no_scope' | 'failed' = 'sent'): Deliver => ({
  admin: fakeAdmin(tables),
  sendToSelf: async (_u, subject, text) => (sent.push(`${subject}\n${text}`), result),
  now,
})

describe('the summary', () => {
  it('goes to the person once, and says the unconfirmed one was not counted as sent', async () => {
    const sent: string[] = []
    const t = base()
    expect(await sendSummary(deliver(t, DAY, sent), U)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('sent 2 applications from your browser: Acme, Stripe')
    expect(sent[0]).toContain('1 application could not be confirmed: Ramp')
    expect(sent[0]).not.toMatch(/sent[^.]*Ramp/)
    expect(sent[0]).not.toMatch(/!|—|receipt/i)
  })

  it('is never emailed twice for one day, even after the hour', async () => {
    const t = base()
    const sent: string[] = []
    await sendSummary(deliver(t, DAY, sent), U)
    const later = new Date(DAY.getTime() + 3 * 3_600_000)
    expect(await sendSummary(deliver(t, later, sent), U)).toBe('duplicate')
    expect(sent).toHaveLength(1)
  })

  it('refuses a second summary within the hour', async () => {
    const t = base()
    t.notification_log.push({ user_id: U, kind: 'summary', subject_id: '2026-10-13', sent_at: new Date(DAY.getTime() - 20 * 60_000).toISOString() })
    expect(await sendSummary(deliver(t), U)).toBe('too_soon')
  })

  it('sends nothing with the summary off, to a demo, or without the Gmail send grant, and gives the claim back on a failure', async () => {
    const sent: string[] = []
    expect(await sendSummary(deliver(base({ preferences: { pipeline: { summary: false } } }), DAY, sent), U)).toBe('off')
    expect(await sendSummary(deliver(base({ is_demo: true }), DAY, sent), U)).toBe('demo')
    expect(sent).toHaveLength(0)
    const t = base()
    expect(await sendSummary(deliver(t, DAY, [], 'no_scope'), U)).toBe('no_scope')
    expect(t.notification_log).toHaveLength(0)
    // so the next try can still deliver it
    expect(await sendSummary(deliver(t, DAY, sent), U)).toBe('sent')
  })

  it('says nothing on a day with nothing to say', async () => {
    const t = base()
    t.pipeline_events = []
    expect(await sendSummary(deliver(t), U)).toBe('empty')
  })
})

describe('alerts', () => {
  const alert = { kind: 'reply', subjectId: 'a1', company: 'Acme', role: 'Backend Engineer', url: '/applications/a1' }

  it('holds everything but offers and interviews during quiet hours, and delivers those', async () => {
    const t = base()
    const sent: string[] = []
    expect(await sendAlert(deliver(t, NIGHT, sent), U, alert)).toEqual({ email: 'held', push: 'held' })
    expect(await sendAlert(deliver(t, NIGHT, sent), U, { ...alert, kind: 'offer_due' })).toMatchObject({ email: 'sent' })
    expect(await sendAlert(deliver(t, NIGHT, sent), U, { ...alert, kind: 'interview', subjectId: 'a2' })).toMatchObject({ email: 'sent' })
    expect(sent).toHaveLength(2)
  })

  it('is never sent twice, and a reply email has no reply text', async () => {
    const t = base()
    const sent: string[] = []
    expect(await sendAlert(deliver(t, DAY, sent), U, alert)).toMatchObject({ email: 'sent' })
    expect(await sendAlert(deliver(t, DAY, sent), U, alert)).toMatchObject({ email: 'duplicate' })
    expect(sent).toHaveLength(1)
    expect(alertText(alert)).toBe('Acme wrote to you about Backend Engineer.')
  })

  it('sends no email with the summary off, and none to a demo', async () => {
    const sent: string[] = []
    expect(await sendAlert(deliver(base({ preferences: { pipeline: { summary: false } } }), DAY, sent), U, alert)).toMatchObject({ email: 'off' })
    expect(await sendAlert(deliver(base({ is_demo: true }), DAY, sent), U, alert)).toMatchObject({ email: 'demo' })
    expect(sent).toHaveLength(0)
  })

  it('pushes to the person\'s browsers once, and forgets a browser that is gone', async () => {
    const t = base()
    t.push_subscriptions = [{ id: 's1', user_id: U, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }, { id: 's2', user_id: U, endpoint: 'https://push.example/2', p256dh: 'k', auth: 'a' }]
    const push = vi.fn(async (s: { endpoint: string }) => (s.endpoint.endsWith('/2') ? ('gone' as const) : ('sent' as const)))
    const d = { ...deliver(t, DAY), push } as Deliver
    expect((await sendAlert(d, U, alert)).push).toBe('sent')
    expect(t.push_subscriptions.map((s) => s.id)).toEqual(['s1'])
    expect((await sendAlert(d, U, alert)).push).toBe('duplicate')
    expect(push).toHaveBeenCalledTimes(2)
  })
})
