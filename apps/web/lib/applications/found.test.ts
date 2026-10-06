// Adding an application by hand, reading and writing CSV, and Confirm for one found in email. A small
// in-memory client stands in for the database; the claims are what is written and what is not.

import { describe, expect, it, vi } from 'vitest'
import { addByHand, csvCell, parseCsv, readImport } from '@/lib/pipeline/add'
import { confirmFound } from './found'

vi.mock('@/lib/entities/companies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entities/companies')>()),
  resolveCompany: async () => null,
}))

type Row = Record<string, any>

function fake(seed: Record<string, Row[]>, missing: string[] = []) {
  const tables: Record<string, Row[]> = { companies: [], jobs: [], applications: [], messages: [], ...seed }
  const writes: { table: string; op: string; row: Row }[] = []
  let n = 0
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let patch: Row = {}
    const hits = () => (tables[table] ??= []).filter((r) => filters.every((f) => f(r)))
    const run = () => {
      if (missing.includes(table)) return { data: null, error: { message: `relation "${table}" does not exist` } }
      if (mode === 'insert' || mode === 'upsert') {
        const row = { id: `${table}-${++n}`, ...patch }
        ;(tables[table] ??= []).push(row)
        writes.push({ table, op: mode, row })
        return { data: row, error: null }
      }
      if (mode === 'update') {
        const h = hits()
        for (const r of h) Object.assign(r, patch)
        writes.push({ table, op: 'update', row: patch })
        return { data: h[0] ?? null, error: null }
      }
      return { data: hits()[0] ?? null, error: null }
    }
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), q),
      order: () => q,
      limit: () => q,
      insert: (v: Row) => ((mode = 'insert'), (patch = v), q),
      upsert: (v: Row) => ((mode = 'upsert'), (patch = v), q),
      update: (v: Row) => ((mode = 'update'), (patch = v), q),
      maybeSingle: async () => run(),
      single: async () => run(),
      then: (res: (v: unknown) => unknown) => res(run()),
    }
    return q
  }
  return { client: { from } as never, tables, writes }
}

describe('CSV', () => {
  it('reads quoted fields, doubled quotes, a line break inside quotes and CRLF, and skips blank rows', () => {
    expect(parseCsv('company,title\r\n"Acme, Inc.","Sr ""Staff"" Engineer"\r\n\r\n"multi\nline",x\n')).toEqual([
      ['company', 'title'],
      ['Acme, Inc.', 'Sr "Staff" Engineer'],
      ['multi\nline', 'x'],
    ])
  })

  it('writes a cell that starts like a formula with a leading apostrophe, and quotes what needs quoting', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    for (const f of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(f).startsWith("'") || csvCell(f).startsWith(`"'`)).toBe(true)
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('')
  })

  it('reads an import by its header, and says what is wrong when the columns are not there', () => {
    expect(readImport('Company,Title,URL,Stage,Applied date\nAcme,Engineer,https://acme.com/1,applied,2026-09-01').rows).toEqual([{ company: 'Acme', title: 'Engineer', url: 'https://acme.com/1', stage: 'applied', appliedAt: '2026-09-01' }])
    expect(readImport('name,role\nAcme,Engineer')).toMatchObject({ rows: [], sentence: expect.stringContaining('company, title') })
    expect(readImport('')).toMatchObject({ sentence: 'That file is empty.' })
    const big = `company,title\n${Array.from({ length: 600 }, (_, i) => `C${i},T`).join('\n')}`
    expect(readImport(big).rows).toHaveLength(500)
  })
})

describe('addByHand', () => {
  it('refuses what it cannot use, before it writes anything', async () => {
    const { client, writes } = fake({})
    for (const [input, sentence] of [
      [{ company: '', title: 'x' }, 'Add a company and a job title.'],
      [{ company: 'Acme', title: 'x', stage: 'hired' }, 'hired is not a stage.'],
      [{ company: 'Acme', title: 'x', appliedAt: '2099-01-01' }, 'That date is not one Cello can use.'],
      [{ company: 'Acme', title: 'x', url: 'javascript:alert(1)' }, 'The link must start with http or https.'],
    ] as const) {
      expect(await addByHand(client, 'u1', input)).toEqual({ ok: false, sentence })
    }
    expect(writes).toHaveLength(0)
  })

  it('adds a company the person does not follow, a role and an application with no state', async () => {
    const { client, writes } = fake({})
    const r = await addByHand(client, 'u1', { company: 'Acme', title: 'Engineer', url: 'https://acme.com/jobs/1', stage: 'applied', appliedAt: '2026-09-01' })
    expect(r).toMatchObject({ ok: true, existed: false })
    const company = writes.find((w) => w.table === 'companies')!.row
    expect(company).toMatchObject({ user_id: 'u1', name: 'Acme' })
    expect('watching' in company).toBe(false)
    const app = writes.find((w) => w.table === 'applications')!.row
    expect(app).toMatchObject({ user_id: 'u1', stage: 'applied', source: 'manual' })
    expect('state' in app).toBe(false)
  })
})

describe('confirmFound', () => {
  const mail: Row = { id: 'm1', user_id: 'u1', sent_at: '2026-10-01T09:00:00Z', job_title: 'Backend Engineer', employer_id: 'emp1', application_id: null, kind: 'applied', trust: 'proven', company_directory: { name: 'Acme', domain: 'acme.com', careers_url: 'https://acme.com/careers' } }

  it('makes the application from the mail, adds the company without following it, links the mail and asks for the applied reaction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { client, tables, writes } = fake({ messages: [{ ...mail }] }, ['role_reactions'])
    const r = await confirmFound(client, 'u1', { messageId: 'm1' })
    expect(r.ok).toBe(true)
    const company = writes.find((w) => w.table === 'companies')!.row
    expect(company).toMatchObject({ user_id: 'u1', name: 'Acme', employer_id: 'emp1', domain: 'acme.com' })
    expect('watching' in company).toBe(false)
    expect(tables.applications[0]).toMatchObject({ user_id: 'u1', stage: 'applied', source: 'gmail_sync', found_state: 'confirmed' })
    expect(tables.messages[0].application_id).toBe(tables.applications[0].id)
    // the history write is asked for as an applied reaction; where its table is not there the failure is said, not swallowed
    expect(writes.some((w) => w.table === 'role_reactions')).toBe(false)
    expect(warn).toHaveBeenCalledWith('could not write the applied reaction:', expect.stringContaining('role_reactions'))
    warn.mockRestore()
  })

  it('writes an applied reaction when the table is there', async () => {
    const { client, writes } = fake({ messages: [{ ...mail }] })
    // the application row is read back for the reaction: give the fake the job it points at
    await confirmFound(client, 'u1', { messageId: 'm1' })
    expect(writes.find((w) => w.table === 'role_reactions')?.row).toMatchObject({ user_id: 'u1', reaction: 'applied', surface: 'applications' })
  })

  it('confirms an application found at a followed company once, for its owner only', async () => {
    const { client, tables } = fake({ applications: [{ id: 'a1', user_id: 'u1', job_id: 'j1', found_state: 'to_confirm' }] })
    expect(await confirmFound(client, 'u2', { applicationId: 'a1' })).toMatchObject({ ok: false })
    expect(await confirmFound(client, 'u1', { applicationId: 'a1' })).toEqual({ ok: true, applicationId: 'a1' })
    expect(tables.applications[0].found_state).toBe('confirmed')
    expect(await confirmFound(client, 'u1', { applicationId: 'a1' })).toMatchObject({ ok: false, sentence: 'That one is gone or already confirmed.' })
  })

  it('does not make an application from a mail that is not proven, not an application or names no role', async () => {
    const { client, tables } = fake({ messages: [{ ...mail, trust: 'unconfirmed' }, { ...mail, id: 'm2', job_title: null }] })
    expect(await confirmFound(client, 'u1', { messageId: 'm1' })).toMatchObject({ ok: false })
    expect(await confirmFound(client, 'u1', { messageId: 'm2' })).toMatchObject({ ok: false, sentence: expect.stringContaining('did not name the role') })
    expect(tables.applications).toHaveLength(0)
    expect(await confirmFound(client, 'u1', {})).toMatchObject({ ok: false, sentence: 'Say which one to confirm.' })
  })
})
