// The lists in types.ts and the check constraints of the migrations are the same lists. A kind added
// in one place and not the other would be refused by the database or never written, so this reads the
// migration and fails on any difference.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACTORS,
  APPLICATION_STATES,
  CHANNELS,
  CLOSED_REASONS,
  COUNT_KINDS,
  EVENT_KINDS,
  EXTENSION_ONLY_KINDS,
  NEEDS_REASONS,
  PERSON_ONLY_KINDS,
  TRUST_LEVELS,
} from './types'

const MIGRATIONS = path.resolve(process.cwd(), '../../supabase/migrations')
const state = readFileSync(path.join(MIGRATIONS, '20261013000001_application_state.sql'), 'utf8')
const functions = readFileSync(path.join(MIGRATIONS, '20261013000002_pipeline_functions.sql'), 'utf8')

/** The quoted words of the first `check (<column> in (...))` for a column. */
function checkList(sql: string, column: string): string[] {
  const m = new RegExp(`${column}\\s+(?:text\\s+)?(?:not null\\s+)?(?:default\\s+'[^']*'\\s+)?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, 'm').exec(sql)
  if (!m) throw new Error(`no check list for ${column}`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('types.ts and the migration are one list', () => {
  it('application states', () => expect(checkList(state, 'state')).toEqual([...APPLICATION_STATES]))
  it('needs reasons', () => expect(checkList(state, 'needs_reason')).toEqual([...NEEDS_REASONS]))
  it('closed reasons', () => expect(checkList(state, 'closed_reason')).toEqual([...CLOSED_REASONS]))
  it('event kinds', () => expect(checkList(state, 'kind').sort()).toEqual([...EVENT_KINDS].sort()))
  it('actors', () => expect(checkList(state, 'actor')).toEqual([...ACTORS]))
  it('channels', () => expect(checkList(state, 'channel')).toEqual([...CHANNELS]))
  it('trust levels', () => expect(checkList(state, 'trust')).toEqual([...TRUST_LEVELS]))

  it('the kinds only the person writes are the ones SQL refuses for everyone else', () => {
    const sql = /v_kind in \(([^)]*)\)\s+and v_actor <> 'person'\s+then/m.exec(functions)
    expect([...(sql?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()).toEqual([...PERSON_ONLY_KINDS].sort())
  })

  it('the kinds only the extension writes', () => {
    const sql = /v_kind in \(([^)]*)\) and v_actor <> 'extension'/.exec(functions)
    expect([...(sql?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()).toEqual([...EXTENSION_ONLY_KINDS].sort())
  })

  it('the kinds that move a count are the ones the T10 check refuses unconfirmed', () => {
    const sql = /kind in \(([^)]*)\) and trust = 'unconfirmed'/.exec(state)
    expect([...(sql?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()).toEqual([...COUNT_KINDS].sort())
  })

  it('every list is free of duplicates', () => {
    for (const list of [APPLICATION_STATES, NEEDS_REASONS, EVENT_KINDS, ACTORS, CHANNELS, TRUST_LEVELS]) {
      expect(new Set(list).size).toBe(list.length)
    }
  })
})
