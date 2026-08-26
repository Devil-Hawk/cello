// Tests for lib/insights/store.ts — the door that replaces standing-
// preferences.ts's 12-slot FIFO (see that module's header for why the FIFO
// existed, and this file's for why it had to die).
//
// The behaviours worth pinning:
//   - readStandingPreferences renders BYTE-IDENTICAL output to the old
//     formatStandingPreferences(readStandingPreferences(jsonb)) for the same
//     data, migrated — the shim contract this replacement makes.
//   - the FIFO bug is actually dead: a 13th preference does not evict the
//     1st — it just falls out of the top-12 INJECTED block while staying
//     retrievable.
//   - contradictions are marked, never deleted — the superseded row is still
//     there, queryable, with a live link to what replaced it.
//   - dedupe: restating a preference refreshes it in place, it does not pile
//     up as a second row.
//   - nothing in production still imports the FIFO module.
//
// An in-memory fake stands in for the DB — same one-off-fake-per-test-file
// idiom as lib/kb/store.test.ts and lib/mcp's own callers; the operations are
// few enough (select/insert/update/eq/order/limit/single/count) that a real
// Postgres would test the SQL, not this module's logic.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadApiKeysMock = vi.fn()
vi.mock('../harness/keys', () => ({ loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args) }))

const callEmbeddingMock = vi.fn()
vi.mock('../harness/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/llm')>()
  return { ...actual, callEmbedding: (...args: unknown[]) => callEmbeddingMock(...args) }
})

const { ingestInsight, readStandingPreferences, MAX_STANDING_PREFERENCES, InsightError } = await import('./store')
const { MissingKeyError } = await import('../harness/llm')

beforeEach(() => {
  loadApiKeysMock.mockReset().mockResolvedValue({})
  // No embedding provider configured, by default, for every test below —
  // embedInsightBestEffort is exercised for its own sake in the "never
  // throws" assertion further down, not in every other test's noise.
  callEmbeddingMock.mockReset().mockRejectedValue(new MissingKeyError('no provider'))
})

// --- in-memory fake admin ----------------------------------------------------

interface Row {
  id: string
  user_id: string
  kind: string
  statement: string
  evidence: unknown
  confidence: number | null
  status: string
  source: string
  company_id: string | null
  supersedes_id: string | null
  embedding: number[] | null
  created_at: string
  updated_at: string
}

function makeFakeAdmin() {
  const rows: Row[] = []
  let seq = 0
  const nextTimestamp = () => new Date(2026, 0, 1, 0, 0, ++seq).toISOString()

  function builder() {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'update' = 'select'
    let insertPayload: Partial<Row> | null = null
    let updatePatch: Partial<Row> | null = null
    let orderCol: keyof Row | null = null
    let orderAsc = true
    let limitN: number | null = null
    let wantSingle = false
    let wantCount = false

    function exec(): { data: unknown; error: null; count?: number } {
      if (mode === 'insert') {
        const row: Row = {
          id: `ins-${++seq}`,
          user_id: insertPayload!.user_id as string,
          kind: insertPayload!.kind as string,
          statement: insertPayload!.statement as string,
          evidence: insertPayload!.evidence ?? null,
          confidence: (insertPayload!.confidence as number | null) ?? null,
          status: 'active',
          source: insertPayload!.source as string,
          company_id: (insertPayload!.company_id as string | null) ?? null,
          supersedes_id: null,
          embedding: null,
          created_at: nextTimestamp(),
          updated_at: nextTimestamp(),
        }
        rows.push(row)
        return { data: wantSingle ? row : [row], error: null }
      }
      if (mode === 'update') {
        const matches = rows.filter((r) => filters.every((f) => f(r)))
        for (const r of matches) Object.assign(r, updatePatch)
        return { data: wantSingle ? (matches[0] ?? null) : matches, error: null }
      }
      let result = rows.filter((r) => filters.every((f) => f(r)))
      if (wantCount) return { data: null, error: null, count: result.length }
      if (orderCol) {
        const col = orderCol
        result = [...result].sort((a, b) => {
          const av = a[col] as string
          const bv = b[col] as string
          const cmp = av < bv ? -1 : av > bv ? 1 : 0
          return orderAsc ? cmp : -cmp
        })
      }
      if (limitN != null) result = result.slice(0, limitN)
      return { data: wantSingle ? (result[0] ?? null) : result, error: null }
    }

    const api = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true
        return api
      },
      eq(col: keyof Row, val: unknown) {
        filters.push((r) => r[col] === val)
        return api
      },
      order(col: keyof Row, opts?: { ascending?: boolean }) {
        orderCol = col
        orderAsc = opts?.ascending ?? true
        return api
      },
      limit(n: number) {
        limitN = n
        return api
      },
      insert(payload: Record<string, unknown>) {
        mode = 'insert'
        insertPayload = payload as Partial<Row>
        return api
      },
      update(patch: Record<string, unknown>) {
        mode = 'update'
        updatePatch = patch as Partial<Row>
        return api
      },
      single() {
        wantSingle = true
        return exec()
      },
      then(resolve: (v: ReturnType<typeof exec>) => void) {
        resolve(exec())
      },
    }
    return api
  }

  // dedupeKey ported straight from the retired standing-preferences.ts (and,
  // for real, from uniq_insights_user_kind_statement_active's expression) —
  // the fake needs its own copy to stand in for what the migration's unique
  // index now enforces.
  const dedupeKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  // upsert_insight — mirrors the migration's single INSERT ... ON CONFLICT
  // statement: one synchronous check-and-write, no separate SELECT round
  // trip for application code to be raced across (see store.ts's header for
  // why that's what actually closes the concurrent-duplicate bug).
  async function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== 'upsert_insight') throw new Error(`fakeAdmin: unexpected rpc "${fn}"`)
    const userId = params.p_user_id as string
    const kind = params.p_kind as string
    const key = dedupeKey(params.p_statement as string)
    const existing = rows.find(
      (r) => r.user_id === userId && r.kind === kind && r.status === 'active' && dedupeKey(r.statement) === key
    )
    if (existing) {
      existing.updated_at = nextTimestamp()
      return { data: [{ ...existing, inserted: false }], error: null }
    }
    const row: Row = {
      id: `ins-${++seq}`,
      user_id: userId,
      kind,
      statement: params.p_statement as string,
      evidence: (params.p_evidence as unknown) ?? null,
      confidence: (params.p_confidence as number | null) ?? null,
      status: 'active',
      source: params.p_source as string,
      company_id: (params.p_company_id as string | null) ?? null,
      supersedes_id: null,
      embedding: null,
      created_at: nextTimestamp(),
      updated_at: nextTimestamp(),
    }
    rows.push(row)
    return { data: [{ ...row, inserted: true }], error: null }
  }

  const admin = { from: (_table: string) => builder(), rpc }
  return { admin: admin as unknown as Parameters<typeof ingestInsight>[0], rows }
}

const U = 'user-1'

// ---------------------------------------------------------------------------
// shim byte-parity: the old FIFO's format, reproduced against migrated rows
// ---------------------------------------------------------------------------

// The retired lib/harness/standing-preferences.ts#formatStandingPreferences,
// reproduced verbatim (not imported — that module is deleted) so the
// byte-parity assertion below still pins the exact prompt text the model saw
// before this migration, not just "produces some text".
function formatStandingPreferencesGolden(prefs: { text: string; recordedAt: string }[]): string {
  if (prefs.length === 0) return ''
  const lines = prefs.map((p) => `- ${p.text}`).join('\n')
  return (
    `WHAT THIS USER HAS TOLD YOU THEY WANT (stated by them, in earlier conversations — ` +
    `honour these without being asked again):\n${lines}\n` +
    `If a request conflicts with one of these, say so and ask which wins — never quietly ignore one.`
  )
}

describe('readStandingPreferences — byte-parity with the retired FIFO format', () => {
  it('renders identically to formatStandingPreferences(readStandingPreferences(jsonb)) for the same data', async () => {
    const formatStandingPreferences = formatStandingPreferencesGolden

    // The old array order: oldest first, most-recently-affirmed last — exactly
    // what addStandingPreference always produced and what the migration's
    // backfill copies straight across.
    const oldStyle = [
      { text: 'Series A+ startups only', recordedAt: '2026-07-01T00:00:00.000Z' },
      { text: 'No big tech', recordedAt: '2026-07-05T00:00:00.000Z' },
      { text: 'Remote only, US timezones', recordedAt: '2026-07-10T00:00:00.000Z' },
    ]
    const expected = formatStandingPreferences(oldStyle)

    const { admin, rows } = makeFakeAdmin()
    for (const p of oldStyle) {
      rows.push({
        id: `mig-${p.text}`,
        user_id: U,
        kind: 'preference',
        statement: p.text,
        evidence: null,
        confidence: null,
        status: 'active',
        source: 'user_stated',
        company_id: null,
        supersedes_id: null,
        embedding: null,
        created_at: p.recordedAt,
        updated_at: p.recordedAt,
      })
    }

    const actual = await readStandingPreferences(admin, U)
    expect(actual).toBe(expected)
  })

  it('renders "" for a user with no preference insights, same as the FIFO did for an empty list', async () => {
    const { admin } = makeFakeAdmin()
    expect(await readStandingPreferences(admin, U)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// the FIFO bug dies: a 13th preference does not evict the 1st
// ---------------------------------------------------------------------------

describe('ingestInsight — no eviction, ever', () => {
  it('all 13 preferences stay retrievable; only the top 12 are injected', async () => {
    const { admin, rows } = makeFakeAdmin()
    for (let i = 1; i <= MAX_STANDING_PREFERENCES + 1; i++) {
      await ingestInsight(admin, U, { kind: 'preference', statement: `preference ${i}`, source: 'user_stated' })
    }

    const active = rows.filter((r) => r.kind === 'preference' && r.status === 'active')
    expect(active).toHaveLength(MAX_STANDING_PREFERENCES + 1)
    expect(active.map((r) => r.statement)).toContain('preference 1')

    const block = await readStandingPreferences(admin, U)
    const lines = block.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(MAX_STANDING_PREFERENCES)
    // The oldest (never repeated) preference falls out of the injected block...
    expect(block).not.toContain('preference 1\n')
    // ...but every one from the 2nd on is still in the top 12 shown to the model.
    for (let i = 2; i <= MAX_STANDING_PREFERENCES + 1; i++) {
      expect(block).toContain(`- preference ${i}`)
    }
  })
})

// ---------------------------------------------------------------------------
// contradiction: marked, never deleted
// ---------------------------------------------------------------------------

describe('ingestInsight — contradiction chain', () => {
  it('marks the superseded row contradicted with a live link, and both stay queryable', async () => {
    const { admin, rows } = makeFakeAdmin()
    const original = await ingestInsight(admin, U, {
      kind: 'preference',
      statement: 'Series A+ only',
      source: 'user_stated',
    })
    const replacement = await ingestInsight(admin, U, {
      kind: 'preference',
      statement: 'Open to any stage now',
      source: 'user_stated',
      supersedesId: original.id,
    })

    expect(rows).toHaveLength(2)
    const oldRow = rows.find((r) => r.id === original.id)!
    const newRow = rows.find((r) => r.id === replacement.id)!
    expect(oldRow.status).toBe('contradicted')
    expect(oldRow.supersedes_id).toBe(newRow.id)
    expect(newRow.status).toBe('active')
    // Never deleted — the row is still there to query, just not active.
    expect(rows.map((r) => r.statement)).toEqual(
      expect.arrayContaining(['Series A+ only', 'Open to any stage now'])
    )
  })
})

// ---------------------------------------------------------------------------
// dedupe: a restatement refreshes in place, it does not pile up
// ---------------------------------------------------------------------------

describe('ingestInsight — dedupe', () => {
  it('a case/punctuation-different restatement refreshes the existing row instead of adding one', async () => {
    const { admin, rows } = makeFakeAdmin()
    const first = await ingestInsight(admin, U, { kind: 'preference', statement: 'Series A+ only', source: 'user_stated' })
    const affirmedAt = rows[0].updated_at
    const second = await ingestInsight(admin, U, { kind: 'preference', statement: 'series a+ only.', source: 'user_stated' })

    expect(second.id).toBe(first.id)
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1)
    // The restatement moved it to "most recently affirmed" — refreshed, not duplicated.
    expect(rows[0].updated_at).not.toBe(affirmedAt)
  })

  it('rejects an empty statement', async () => {
    const { admin } = makeFakeAdmin()
    await expect(ingestInsight(admin, U, { kind: 'preference', statement: '   ', source: 'user_stated' })).rejects.toThrow(
      InsightError
    )
  })

  it('two concurrent calls for the same normalized statement still leave exactly one active row', async () => {
    // Regression for the SELECT-then-INSERT race: ingestInsight now makes
    // exactly one round trip (the upsert_insight RPC) with no await between
    // its dup-check and its write, mirroring the migration's single
    // INSERT ... ON CONFLICT statement — there is no window left for a
    // second caller to observe "no dup yet" before the first caller's write
    // lands, in the fake or (via uniq_insights_user_kind_statement_active)
    // in real Postgres.
    const { admin, rows } = makeFakeAdmin()
    const [a, b] = await Promise.all([
      ingestInsight(admin, U, { kind: 'preference', statement: 'Series A+ only', source: 'user_stated' }),
      ingestInsight(admin, U, { kind: 'preference', statement: 'series a+ only.', source: 'user_stated' }),
    ])
    expect(a.id).toBe(b.id)
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// standing-preferences.ts: zero production imports after this commit
// ---------------------------------------------------------------------------

describe('lib/harness/standing-preferences.ts has no production importers', () => {
  const WEB_ROOT = process.cwd()

  function walk(dir: string, keep: (name: string) => boolean): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (entry === 'node_modules' || entry === '.next') continue
      if (statSync(full).isDirectory()) out.push(...walk(full, keep))
      else if (keep(entry)) out.push(full)
    }
    return out
  }

  const isTest = (name: string) => name.includes('.test.') || name.includes('.eval.')
  const productionFiles = [
    ...walk(path.resolve(WEB_ROOT, 'lib'), (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !isTest(n)),
    ...walk(path.resolve(WEB_ROOT, 'app'), (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !isTest(n)),
  ].filter((f) => path.relative(WEB_ROOT, f) !== 'lib/harness/standing-preferences.ts')

  it('finds files to check (a broken walk must not pass silently)', () => {
    expect(productionFiles.length).toBeGreaterThan(50)
  })

  it('no production file imports standing-preferences.ts', () => {
    const importPattern = /from\s+['"][^'"]*standing-preferences['"]/
    const offenders = productionFiles
      .filter((f) => importPattern.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(WEB_ROOT, f))
    expect(offenders).toEqual([])
  })
})
