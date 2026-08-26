// lib/ats-apply/phase-tokens.ts — token lifecycle (ruling 8): TTL, single-use,
// atomic under concurrent claim, and reissue invalidating a stale token.
//
// The fake store below models the ONE property the real Postgres UPDATE
// relies on: a write only matches rows where `consumed_at is null` AT THE
// MOMENT IT RUNS, and two writes against the same row never both see NULL —
// whichever runs first flips it for the other. JS is single-threaded, so
// "concurrent" here means "issued back-to-back with no await between them
// deciding a winner", which is exactly the interleaving that matters: two
// requests landing on the bundle route at nearly the same time.

import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  consumePhaseToken,
  issuePhaseToken,
  mintReportToken,
  verifyReportToken,
  PHASE_TOKEN_TTL_MS,
} from './phase-tokens'
import type { AdminClient } from '@/lib/harness/types'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface Row {
  id: string
  draft_id: string
  user_id: string
  phase: string
  token_hash: string
  issued_at: string
  expires_at: string
  consumed_at: string | null
}

let rows: Row[]
let nextId: number

function makeAdmin(): AdminClient {
  const admin = {
    from(table: string) {
      expect(table).toBe('apply_phase_tokens')
      const filters: ((r: Row) => boolean)[] = []
      let pendingUpdate: Partial<Row> | null = null

      // UPDATE evaluates its WHERE against the CURRENT state at the instant
      // maybeSingle()/single() actually runs — the whole point under test —
      // so filtering re-reads `rows` fresh on every terminal call rather
      // than snapshotting when the chain was built.
      function matched(): Row[] {
        return rows.filter((r) => filters.every((f) => f(r)))
      }

      const self = {
        eq(col: keyof Row, val: unknown) {
          filters.push((r) => r[col] === val)
          return self
        },
        gt(col: keyof Row, val: unknown) {
          filters.push((r) => (r[col] as string) > (val as string))
          return self
        },
        is(col: keyof Row, val: null) {
          filters.push((r) => r[col] === val)
          return self
        },
        not(col: keyof Row, op: string, val: unknown) {
          if (op === 'is' && val === null) {
            filters.push((r) => r[col] !== null)
            return self
          }
          throw new Error(`fake admin: unsupported .not(${String(col)}, ${op}, ${val})`)
        },
        select() {
          return self
        },
        update(patch: Partial<Row>) {
          pendingUpdate = patch
          return self
        },
        async maybeSingle() {
          const rowsBefore = matched()
          if (rowsBefore.length > 1) throw new Error('more than one row matched maybeSingle')
          const row = rowsBefore[0] ?? null
          if (pendingUpdate && row) Object.assign(row, pendingUpdate)
          return { data: row ? { id: row.id } : null, error: null }
        },
        async single() {
          const rowsBefore = matched()
          const row = rowsBefore[rowsBefore.length - 1]
          return { data: row, error: row ? null : { message: 'not found' } }
        },
        // Makes the chain awaitable WITHOUT a terminal .select()/.maybeSingle()
        // call, matching real supabase-js's thenable PostgrestFilterBuilder —
        // issuePhaseToken()'s invalidation UPDATE relies on exactly this.
        then(resolve: (v: { data: unknown; error: null }) => void) {
          const rowsBefore = matched()
          if (pendingUpdate) for (const r of rowsBefore) Object.assign(r, pendingUpdate)
          resolve({ data: rowsBefore, error: null })
        },
        insert(row: Record<string, unknown>) {
          // Mirrors 20260819000004_apply_phase_tokens_live_unique.sql's
          // partial unique index: at most one row with consumed_at IS NULL
          // per (draft_id, phase). A true concurrent double-mint (both
          // invalidation UPDATEs run before either INSERT commits) hits
          // this on the loser's insert.
          const liveClash = rows.some(
            (r) => r.draft_id === row.draft_id && r.phase === row.phase && r.consumed_at === null
          )
          if (liveClash) {
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: null,
                      error: { message: 'duplicate key value violates unique constraint "apply_phase_tokens_live_unique"' },
                    }
                  },
                }
              },
            }
          }
          const id = `row-${nextId++}`
          const full: Row = {
            id,
            draft_id: row.draft_id as string,
            user_id: row.user_id as string,
            phase: row.phase as string,
            token_hash: row.token_hash as string,
            issued_at: new Date().toISOString(),
            expires_at: row.expires_at as string,
            consumed_at: null,
          }
          rows.push(full)
          return {
            select() {
              return {
                async single() {
                  return { data: full, error: null }
                },
              }
            },
          }
        },
      }
      return self
    },
  }
  return admin as unknown as AdminClient
}

let admin: AdminClient

beforeEach(() => {
  rows = []
  nextId = 1
  admin = makeAdmin()
})

describe('issuePhaseToken', () => {
  it('sets expires_at within PHASE_TOKEN_TTL_MS (15 minutes) of now', async () => {
    const before = Date.now()
    const issued = await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const ttl = new Date(issued.expiresAt).getTime() - before
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(PHASE_TOKEN_TTL_MS + 1000) // slack for test wall-clock
    expect(PHASE_TOKEN_TTL_MS).toBe(15 * 60 * 1000)
  })

  it('invalidates a still-live token for the same (draft, phase) before minting a new one', async () => {
    const first = await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })

    // The FIRST token must no longer be consumable — a stale mint (e.g. a
    // retried prepare() call) cannot linger as a second live authorization.
    const firstRow = rows.find((r) => r.id === first.id)!
    expect(firstRow.consumed_at).not.toBeNull()

    // Exactly one live row remains.
    const live = rows.filter((r) => r.draft_id === 'd1' && r.phase === 'fill' && r.consumed_at === null)
    expect(live.length).toBe(1)
  })

  it('does not touch a token for a DIFFERENT phase on the same draft', async () => {
    const fillToken = await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'submit' })
    const fillRow = rows.find((r) => r.id === fillToken.id)!
    expect(fillRow.consumed_at).toBeNull()
  })
})

describe('consumePhaseToken', () => {
  it('consumes the live token once and returns true', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const ok = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    expect(ok).not.toBeNull()
    expect(ok!.id).toBe(rows[0].id)
    expect(rows[0].consumed_at).not.toBeNull()
  })

  it('is single-use: a second consume for the same (draft, phase) returns false', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const first = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    const second = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('refuses when no token was ever issued', async () => {
    const ok = await consumePhaseToken(admin, { draftId: 'no-such-draft', phase: 'fill' })
    expect(ok).toBeNull()
  })

  it('refuses an expired token even though it was never consumed', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    rows[0].expires_at = new Date(Date.now() - 1000).toISOString() // force past
    const ok = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    expect(ok).toBeNull()
    expect(rows[0].consumed_at).toBeNull() // an expired token is refused, not marked consumed
  })

  it('is atomic under a simulated concurrent claim: exactly one of two racing consumers wins', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'submit' })

    // Two consumers "racing": both build their UPDATE against the same
    // pre-race state, but the fake store (like Postgres) evaluates each
    // UPDATE's WHERE against the row as it stands WHEN THAT UPDATE RUNS —
    // so the second one, running after the first has committed, sees
    // consumed_at already set and matches nothing.
    const [a, b] = await Promise.all([
      consumePhaseToken(admin, { draftId: 'd1', phase: 'submit' }),
      consumePhaseToken(admin, { draftId: 'd1', phase: 'submit' }),
    ])

    const winners = [a, b].filter(Boolean)
    expect(winners.length).toBe(1)
  })

  it('never consumes a different draft or a different phase on the same draft', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const wrongDraft = await consumePhaseToken(admin, { draftId: 'd2', phase: 'fill' })
    const wrongPhase = await consumePhaseToken(admin, { draftId: 'd1', phase: 'submit' })
    expect(wrongDraft).toBeNull()
    expect(wrongPhase).toBeNull()
    expect(rows[0].consumed_at).toBeNull()
  })

  it('a true concurrent double-mint leaves at most one live row — the loser throws rather than creating two', async () => {
    // Both issuePhaseToken() calls' invalidation UPDATEs match nothing (no
    // row exists yet) before either has inserted — exactly the interleaving
    // the migration's partial unique index exists to catch.
    const results = await Promise.allSettled([
      issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'submit' }),
      issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'submit' }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    const live = rows.filter((r) => r.draft_id === 'd1' && r.phase === 'submit' && r.consumed_at === null)
    expect(live.length).toBe(1)
  })
})

describe('mintReportToken / verifyReportToken', () => {
  it('with TWO consumed rows for one (draft, phase), the mint lands only on the named row', async () => {
    // The exact hole the stage-4 panel caught: an earlier consumed (e.g.
    // expired-then-reissued) row for the same pair must never receive the
    // fresh report hash — only the row THIS consumption claimed.
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const first = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const second = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second!.id).not.toBe(first!.id)

    const firstHashBefore = rows.find((r) => r.id === first!.id)!.token_hash
    const token = await mintReportToken(admin, { draftId: 'd1', phase: 'fill', consumedRowId: second!.id })

    expect(rows.find((r) => r.id === second!.id)!.token_hash).toBe(sha256Hex(token))
    expect(rows.find((r) => r.id === first!.id)!.token_hash).toBe(firstHashBefore)
  })


  it('verifies a token minted for a consumed row, hashed correctly', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const consumed = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    const token = await mintReportToken(admin, { draftId: 'd1', phase: 'fill', consumedRowId: consumed!.id })

    expect(rows[0].token_hash).toBe(sha256Hex(token))
    const ok = await verifyReportToken(admin, { draftId: 'd1', phase: 'fill', reportToken: token })
    expect(ok).toBe(true)
  })

  it('rejects a wrong token', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const consumed = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    await mintReportToken(admin, { draftId: 'd1', phase: 'fill', consumedRowId: consumed!.id })
    const ok = await verifyReportToken(admin, { draftId: 'd1', phase: 'fill', reportToken: 'not-the-real-token' })
    expect(ok).toBe(false)
  })

  it('rejects an empty token without querying the store', async () => {
    const ok = await verifyReportToken(admin, { draftId: 'd1', phase: 'fill', reportToken: '' })
    expect(ok).toBe(false)
  })

  it('rejects a token for the right value but the wrong phase', async () => {
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const consumed = await consumePhaseToken(admin, { draftId: 'd1', phase: 'fill' })
    const token = await mintReportToken(admin, { draftId: 'd1', phase: 'fill', consumedRowId: consumed!.id })
    const ok = await verifyReportToken(admin, { draftId: 'd1', phase: 'submit', reportToken: token })
    expect(ok).toBe(false)
  })

  it('rejects a token minted for a row that was never actually consumed (no bundle call happened)', async () => {
    // issuePhaseToken() alone never sets consumed_at — mintReportToken()'s
    // WHERE consumed_at IS NOT NULL means it cannot touch a merely-issued,
    // never-fetched row.
    await issuePhaseToken(admin, { draftId: 'd1', userId: 'u1', phase: 'fill' })
    const forgedToken = 'attacker-guessed-value'
    rows[0].token_hash = sha256Hex(forgedToken) // simulates an attacker who somehow knew the hash target
    const ok = await verifyReportToken(admin, { draftId: 'd1', phase: 'fill', reportToken: forgedToken })
    expect(ok).toBe(false) // consumed_at is still null on that row
  })
})
