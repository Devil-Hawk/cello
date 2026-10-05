import { describe, expect, it } from 'vitest'
import { readStoredVerdicts } from './verdicts'

type VerdictRow = {
  subject_id: string
  judge: string
  verdict: string
  score: number | null
  rationale: string | null
  created_at: string
}

/** Rows come back newest first, like the real query orders them. */
function fakeAdmin(rows: VerdictRow[], error: { message: string } | null = null) {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) builder[m] = () => builder
  builder.order = async () => ({ data: error ? null : sorted, error })
  return { from: () => builder } as never
}

const v = (subject_id: string, judge: string, verdict: string, created_at: string, rationale = `${judge} ${verdict}`): VerdictRow => ({
  subject_id,
  judge,
  verdict,
  score: null,
  rationale,
  created_at,
})

describe('readStoredVerdicts', () => {
  it('returns the latest verdict per judge for each message', async () => {
    const out = await readStoredVerdicts(
      fakeAdmin([
        v('m1', 'factuality', 'fail', '2026-10-01T00:00:01Z'),
        v('m1', 'factuality', 'pass', '2026-10-01T00:00:05Z'), // a re-check
        v('m1', 'closed_qa', 'pass', '2026-10-01T00:00:01Z'),
        v('m2', 'factuality', 'pass', '2026-10-01T00:00:02Z'),
      ]),
      'user-1',
      [
        { id: 'm1', updated_at: '2026-10-01T00:00:00Z' },
        { id: 'm2', updated_at: '2026-10-01T00:00:00Z' },
      ]
    )

    expect(out.get('m1')?.map((x) => [x.judge, x.verdict]).sort()).toEqual([
      ['closed_qa', 'pass'],
      ['factuality', 'pass'],
    ])
    expect(out.get('m2')).toHaveLength(1)
  })

  it('drops a verdict older than the last edit: it describes text that no longer exists', async () => {
    const out = await readStoredVerdicts(fakeAdmin([v('m1', 'factuality', 'pass', '2026-10-01T00:00:05Z')]), 'user-1', [
      { id: 'm1', updated_at: '2026-10-01T00:10:00Z' },
    ])
    expect(out.get('m1')).toBeUndefined()
  })

  it('keeps a refusal verdict with its reason, so the card can say why nothing was scored', async () => {
    const out = await readStoredVerdicts(
      fakeAdmin([v('m1', 'factuality', 'unjudged', '2026-10-01T00:00:05Z', 'Quality check failed to run unexpectedly.')]),
      'user-1',
      [{ id: 'm1', updated_at: '2026-10-01T00:00:00Z' }]
    )
    expect(out.get('m1')).toEqual([
      { judge: 'factuality', verdict: 'unjudged', score: null, rationale: 'Quality check failed to run unexpectedly.' },
    ])
  })

  it('a failed read means no verdicts, never an error for the list', async () => {
    const out = await readStoredVerdicts(fakeAdmin([], { message: 'boom' }), 'user-1', [
      { id: 'm1', updated_at: '2026-10-01T00:00:00Z' },
    ])
    expect(out.size).toBe(0)
  })

  it('does not query at all for an empty list', async () => {
    const admin = { from: () => { throw new Error('should not query') } } as never
    expect((await readStoredVerdicts(admin, 'user-1', [])).size).toBe(0)
  })
})
