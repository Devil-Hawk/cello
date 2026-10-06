import { describe, expect, it } from 'vitest'
import type { ActivityRow, ApplicationRow } from '../datasource'
import { MIN_PER_BUCKET, MIN_TOTAL_FOR_CHANCE_ACCURACY } from '../thresholds'
import { analyzeChanceAccuracy } from './chanceAccuracy'

let n = 0
function app(chance: string | null): ApplicationRow {
  n += 1
  return {
    id: `a${n}`,
    jobId: `j${n}`,
    stage: 'applied',
    appliedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    applicationSource: 'triage',
    companyId: 'c',
    companyName: 'Acme',
    jobSource: 'greenhouse',
    jobPostedAt: null,
    chance,
    jobFunction: null,
    seniority: null,
  }
}

/** `count` applications with this chance, `replies` of which got a reply. */
function group(chance: string | null, count: number, replies: number): { apps: ApplicationRow[]; acts: ActivityRow[] } {
  const apps = Array.from({ length: count }, () => app(chance))
  const acts = apps.slice(0, replies).map((a, i) => ({ id: `act-${a.id}-${i}`, applicationId: a.id, type: 'email_received', occurredAt: '2026-10-02T00:00:00Z' }))
  return { apps, acts }
}

function run(groups: ReturnType<typeof group>[]) {
  return analyzeChanceAccuracy(
    groups.flatMap((g) => g.apps),
    groups.flatMap((g) => g.acts)
  )
}

describe('analyzeChanceAccuracy', () => {
  it('refuses with too few applications that carry a chance call, and counts only those', () => {
    const r = run([group('strong', 6, 3), group(null, 40, 10), group('cannot_assess', 10, 1)])
    expect(r.status).toBe('insufficient_data')
    expect(r.sampleSize).toBe(6)
  })

  it('refuses when fewer than two groups have enough applications of their own', () => {
    const r = run([group('strong', MIN_TOTAL_FOR_CHANCE_ACCURACY + 5, 10), group('possible', MIN_PER_BUCKET - 1, 1), group('stretch', 2, 0)])
    expect(r.status).toBe('insufficient_data')
  })

  it('validates when the reply rate falls as the call weakens, with enough samples', () => {
    const r = run([group('strong', 10, 6), group('possible', 10, 3), group('stretch', 10, 1)])
    expect(r.status).toBe('answered')
    if (r.status !== 'answered') return
    expect(r.data.verdict).toBe('validates')
    expect(r.data.buckets.map((b) => b.label)).toEqual(['Strong', 'Possible', 'Stretch'])
    expect(r.summary).toMatch(/Strong: 60%/)
    expect(r.summary).not.toMatch(/score/i)
  })

  it('refutes when a weaker call gets more replies than a stronger one', () => {
    const r = run([group('strong', 10, 1), group('possible', 10, 3), group('stretch', 10, 5)])
    expect(r.status).toBe('answered')
    if (r.status !== 'answered') return
    expect(r.data.verdict).toBe('refutes')
  })

  it('compares only the groups with enough volume and says which were left out', () => {
    const r = run([group('strong', 12, 7), group('possible', 3, 3), group('stretch', 12, 2)])
    expect(r.status).toBe('answered')
    if (r.status !== 'answered') return
    expect(r.data.verdict).toBe('validates')
    expect(r.caveats?.join(' ')).toMatch(/1 chance group\(s\) have fewer than/)
  })
})
