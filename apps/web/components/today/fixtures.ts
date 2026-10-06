// Made-up Today data for the Today fixture and its tests. No company here is real.

import { fixtureRoles } from '@/components/roles/fixtures'
import type { SentRow } from './logic'
import type { TodayData } from './today-view'

const NOW = Date.UTC(2026, 9, 6, 14)

export function fixtureSent(count: number): SentRow[] {
  return fixtureRoles(count, Math.max(count, 1)).map((r, i) => ({
    jobId: r.id,
    title: r.title,
    company: r.company,
    companyId: r.companyId,
    domain: null,
    logoUrl: null,
    at: new Date(NOW - (i + 2) * 86_400_000).toISOString(),
    closed: i % 4 === 3,
    stage: 'applied',
  }))
}

export function fixtureToday(over: Partial<TodayData> = {}): TodayData {
  const items = fixtureRoles(6, 6)
  return {
    state: 'ready',
    band: { kind: 'newest', items },
    newCount: 41,
    check: 'Checked 2 hours ago. Next check at 18:00 UTC.',
    working: false,
    since: { kept: 12, changes: [] },
    sent: [],
    canReadReplies: true,
    hasModel: true,
    now: NOW,
    ...over,
  }
}
