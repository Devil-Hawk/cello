// Needs you: one list, one row per target, the order of 4.4, and a ready row that counts each application.
// A small in-memory client stands in for the tables.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadNeedsYou, order } from './index'
import type { NeedsYouRow } from './types'

type Row = Record<string, any>

function client(tables: Record<string, Row[]>): any {
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])]
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        is: (c: string, v: unknown) => ((rows = rows.filter((r) => (r[c] ?? null) === v)), q),
        not: (c: string, _op: string, v: unknown) => ((rows = rows.filter((r) => (r[c] ?? null) !== v)), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
      }
      return q
    },
  }
}

const NOW = new Date('2026-10-14T12:00:00Z')
const U = 'u1'
const job = (title: string, company: string) => ({ title, companies: { id: `co-${company}`, name: company, logo_url: null } })
const app = (id: string, over: Row = {}): Row => ({
  id, user_id: U, state: null, step: null, needs_reason: null, needs_detail: null, stage: 'applied', closed_reason: null,
  applied_at: '2026-10-13T12:00:00Z', interview_at: null, last_event_at: '2026-10-13T12:00:00Z', found_state: null, jobs: job('Engineer', 'Acme'), ...over,
})

const rowsOf = async (tables: Record<string, Row[]>) =>
  loadNeedsYou(client({ profiles: [{ id: U, preferences: {} }], messages: [], ...tables }), U, NOW)

describe('Needs you', () => {
  it('gives every row its company, a sentence and a button', async () => {
    const list = await rowsOf({
      applications: [
        app('a1', { state: 'needs_you', needs_reason: 'approve_resume', jobs: job('Backend Engineer', 'Stripe') }),
        app('a2', { state: 'needs_you', needs_reason: 'your_turn', needs_detail: { cause: 'sign_in' }, jobs: job('Data Engineer', 'Amazon') }),
        app('a3', { state: 'needs_you', needs_reason: 'answer', jobs: job('SRE', 'Ramp') }),
      ],
    })
    expect(list.rows).toHaveLength(3)
    for (const r of list.rows) {
      expect(r.companyName).toBeTruthy()
      expect(r.sentence.length).toBeGreaterThan(5)
      expect(r.button.label).toBeTruthy()
      expect(r.button.command).toBeTruthy()
    }
    expect(list.rows.find((r) => r.kind === 'your_turn')?.sentence).toContain('Amazon')
  })

  it('is one grouped row for the ready applications, each counted in the badge', async () => {
    const list = await rowsOf({
      applications: [app('r1', { state: 'ready' }), app('r2', { state: 'ready' }), app('r3', { state: 'ready' }), app('n1', { state: 'needs_you', needs_reason: 'answer' })],
    })
    const ready = list.rows.filter((r) => r.kind === 'ready')
    expect(ready).toHaveLength(1)
    expect(ready[0].members).toHaveLength(3)
    expect(ready[0].count).toBe(3)
    expect(list.count).toBe(4)
  })

  it('never has two rows for one target', async () => {
    const dup: NeedsYouRow = {
      id: 'x', kind: 'reply', group: 'reply', target: { kind: 'application', id: 'a1' }, companyId: null, companyName: 'A', logoUrl: null, roleTitle: null,
      sentence: 's', dueAt: null, button: { label: 'Open', command: '/x' }, count: 1, members: [],
    }
    expect(order([dup, { ...dup, id: 'y', kind: 'follow_up_due', group: 'follow_up' }], NOW)).toHaveLength(1)
  })

  it('reads in the order of rule 1: due within 48 hours, then the groups', async () => {
    const mk = (id: string, group: NeedsYouRow['group'], dueAt: string | null): NeedsYouRow => ({
      id, kind: 'reply', group, target: { kind: 'application', id }, companyId: null, companyName: id, logoUrl: null, roleTitle: null,
      sentence: id, dueAt, button: { label: 'Open', command: '/x' }, count: 1, members: [],
    })
    const sorted = order([mk('setup', 'setup', null), mk('question', 'question', null), mk('approval', 'approval', null), mk('later', 'reply', '2026-10-20T00:00:00Z'), mk('soon', 'follow_up', '2026-10-15T00:00:00Z')], NOW)
    expect(sorted.map((r) => r.id)).toEqual(['soon', 'later', 'approval', 'question', 'setup'])
  })

  it('lists an application found in email once, with Confirm', async () => {
    const list = await rowsOf({
      applications: [app('f1', { found_state: 'to_confirm', jobs: job('Backend Engineer', 'Acme') })],
      messages: [{ id: 'm1', user_id: U, application_id: null, kind: 'applied', trust: 'proven', employer_id: 'e1', sent_at: '2026-10-13T00:00:00Z', job_title: 'Data Engineer', company_directory: { name: 'Northwind' } }],
    })
    expect(list.rows.map((r) => r.kind)).toEqual(['confirm_found', 'confirm_found'])
    expect(list.rows.every((r) => r.button.label === 'Confirm')).toBe(true)
  })

  it('says nothing about a closed application or a silent one that is too recent', async () => {
    const list = await rowsOf({ applications: [app('c1', { stage: 'rejected' }), app('c2', { applied_at: '2026-10-13T12:00:00Z' })] })
    expect(list.rows).toEqual([])
    expect(list.count).toBe(0)
  })
})

describe('the old name for what was sent', () => {
  it('is read nowhere outside the migrations (its view can be dropped)', () => {
    const root = path.resolve(process.cwd(), '../..')
    const files = execFileSync('git', ['grep', '-l', 'application_receipts', '--', 'apps', 'scripts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => f !== 'apps/web/lib/needs-you/needs-you.test.ts')
    // a comment that names the old file is history, not a read
    const reads = files.filter((f) => readFileSync(path.join(root, f), 'utf8').split('\n').some((l) => l.includes('application_receipts') && !/^\s*(\/\/|\*|\/\*)/.test(l)))
    expect(reads).toEqual([])
  })
})
