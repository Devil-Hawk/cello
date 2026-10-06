import { describe, expect, it } from 'vitest'
import { saveCompany } from './add'

// Minimal chainable fake: records the write and answers the lookup with `existing`.
function fakeDb(existing: Record<string, unknown> | null, writeError: { message: string } | null = null) {
  const calls: { op: string; payload?: any; id?: string }[] = []
  const db = {
    rpc: async (name: string, args: any) => {
      calls.push({ op: `rpc ${name}`, payload: args })
      return { data: { ok: true }, error: null }
    },
    from() {
      let op = 'select'
      let payload: any
      const q: any = {
        select: () => q,
        eq: (col: string, v: string) => {
          if (col === 'id') calls.push({ op, payload, id: v })
          return q
        },
        or: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: existing, error: null }),
        insert: (p: any) => {
          op = 'insert'
          payload = p
          calls.push({ op, payload })
          return q
        },
        update: (p: any) => {
          op = 'update'
          payload = p
          return q
        },
        single: async () => ({ data: writeError ? null : { id: 'new-id' }, error: writeError }),
        then: (res: any) => res({ error: writeError }),
      }
      return q
    },
  }
  return { db: db as any, calls }
}

const notion = { name: 'Notion', domain: 'notion.so', careerUrl: 'https://notion.so/careers', logoUrl: null, isDream: true }

describe('saveCompany', () => {
  it('promotes a hidden suggested lead instead of failing on the unique key', async () => {
    const { db, calls } = fakeDb({ id: 'lead-1', name: 'Notion', domain: 'notion.so', metadata: { suggested: true, source: 'sourcer' } })
    const res = await saveCompany(db, 'u1', notion)
    expect(res).toEqual({ id: 'lead-1' })
    const update = calls.find((c) => c.op === 'update')!
    expect(update.id).toBe('lead-1')
    expect(update.payload.metadata).toEqual({ source: 'sourcer' })
    expect(update.payload.career_url).toBe('https://notion.so/careers')
    expect(update.payload.is_dream_company).toBe(true)
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
    // followed through the one writer, not by a write to the column
    expect(update.payload.watching).toBeUndefined()
    expect(calls.find((c) => c.op === 'rpc companies_follow')?.payload).toEqual({ p_ids: ['lead-1'], p_on: true, p_user: 'u1' })
  })

  it('says so when the company is already tracked', async () => {
    const { db } = fakeDb({ id: 't', name: 'Notion', domain: 'notion.so', metadata: null })
    const res = await saveCompany(db, 'u1', notion)
    expect(res.error).toMatch(/already track Notion/)
  })

  it('inserts when nothing matches', async () => {
    const { db, calls } = fakeDb(null)
    expect(await saveCompany(db, 'u1', notion)).toEqual({ id: 'new-id' })
    expect(calls[0].payload.name_key).toBe('notion')
    expect(calls[0].payload.watching).toBeUndefined()
    expect(calls.find((c) => c.op === 'rpc companies_follow')?.payload).toEqual({ p_ids: ['new-id'], p_on: true, p_user: 'u1' })
  })

  it('returns the database error instead of dropping it', async () => {
    const { db } = fakeDb(null, { message: 'duplicate key' })
    const res = await saveCompany(db, 'u1', notion)
    expect(res.error).toMatch(/duplicate key/)
  })
})
