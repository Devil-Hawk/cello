// Every public table that holds a person's rows by user_id must be on the
// owned-tables list, or demo wipe and account deletion would silently skip it.
// The scan reads supabase/migrations as text (migration-scan.ts).

import { describe, expect, it } from 'vitest'
import { userIdTables, userIdTablesInRepo } from './migration-scan'
import { OWNED_TABLES } from './owned'

const ownedNames = new Set(OWNED_TABLES.map((t) => t.table))
const missing = (tables: Set<string>) => [...tables].filter((t) => !ownedNames.has(t)).sort()

describe('the owned-tables list', () => {
  it('covers every user_id table in the real migrations', () => {
    expect(missing(userIdTablesInRepo())).toEqual([])
  })

  it('fails on a planted table with a user_id column', () => {
    const planted = userIdTables([
      { name: '29990101000000_planted.sql', sql: 'create table if not exists public.planted_table (\n  id uuid primary key,\n  user_id uuid not null\n);' },
    ])
    expect(missing(planted)).toEqual(['planted_table'])
  })

  it('has no duplicate table across the lane files', () => {
    expect(ownedNames.size).toBe(OWNED_TABLES.length)
  })

  it('never wipes the spend ledger when a demo expires', () => {
    expect(OWNED_TABLES.find((t) => t.table === 'llm_spend')?.demoWipe).toBe(false)
  })
})

describe('the migration scan', () => {
  const scan = (...sql: string[]) => userIdTables(sql.map((s, i) => ({ name: `2999010100000${i}_t.sql`, sql: s })))

  it('follows add column and drop table in version order', () => {
    expect([...scan('create table a (id uuid);', 'alter table public.a add column if not exists user_id uuid;')]).toEqual(['a'])
    expect([...scan('create table b (user_id uuid);', 'drop table if exists public.b;')]).toEqual([])
  })

  it('follows a rename', () => {
    expect([...scan('create table f (user_id uuid);', 'alter table public.f rename to g;')]).toEqual(['g'])
  })

  it('ignores a table with no user_id and a user_id named only in a comment', () => {
    expect([...scan('create table c (id uuid, owner_user_id uuid);')]).toEqual([])
    expect([...scan('-- create table d (user_id uuid);\nselect 1;')]).toEqual([])
  })

  it('reads a user_id after a foreign-key column and inside nested parentheses', () => {
    expect([...scan('create table e (id uuid default gen_random_uuid(), user_id uuid references public.profiles(id));')]).toEqual(['e'])
  })
})
