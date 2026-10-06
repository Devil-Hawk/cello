// Every table that holds a person's rows by user_id says where its values come
// from: it carries origin, prov and confirmed_at, or it is listed as wholly code
// or wholly the person (blueprint 3.2).

import { describe, expect, it } from 'vitest'
import { originTables, originTablesInRepo, userIdTables, userIdTablesInRepo } from '../commands/migration-scan'
import { PROVENANCE_TABLES } from './tables'

const listed = new Set(PROVENANCE_TABLES.map((t) => t.table))

describe('the provenance table list', () => {
  it('lists every user_id table in the real migrations', () => {
    expect([...userIdTablesInRepo()].filter((t) => !listed.has(t)).sort()).toEqual([])
  })

  it('fails on a planted user_id table that nobody listed', () => {
    const planted = userIdTables([{ name: '29990101000000_p.sql', sql: 'create table public.planted (id uuid, user_id uuid);' }])
    expect([...planted].filter((t) => !listed.has(t))).toEqual(['planted'])
  })

  it('lists a table once', () => {
    expect(listed.size).toBe(PROVENANCE_TABLES.length)
  })

  it('has the origin column on every table listed as origin', () => {
    const withOrigin = originTablesInRepo()
    const missing = PROVENANCE_TABLES.filter((t) => t.provenance === 'origin' && !withOrigin.has(t.table)).map((t) => t.table)
    expect(missing).toEqual([])
  })

  it('names the package that retires a table still holding model-written text', () => {
    for (const t of PROVENANCE_TABLES.filter((t) => t.retiredBy)) expect(t.retiredBy, t.table).toMatch(/^K\d+/)
  })
})

describe('the origin scan', () => {
  it('reads the four tables K11 gives the three columns, from the looping migration', () => {
    const found = originTablesInRepo()
    for (const t of ['person_roles', 'jobs', 'artifacts', 'artifact_versions']) expect(found.has(t), t).toBe(true)
  })

  it('reads a created column, an added column and a drop', () => {
    const files = [
      { name: '29990101000000_a.sql', sql: "create table a (id uuid, origin text not null default 'code');" },
      { name: '29990101000001_b.sql', sql: 'create table b (id uuid); alter table b add column if not exists origin text;' },
      { name: '29990101000002_c.sql', sql: 'create table c (id uuid, origin text); drop table c;' },
    ]
    expect([...originTables(files)].sort()).toEqual(['a', 'b'])
  })
})
