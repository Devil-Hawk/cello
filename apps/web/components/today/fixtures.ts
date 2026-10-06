// Made-up Today data for the Today fixture and its tests. No company here is real.

import { fixtureRoles } from '@/components/roles/fixtures'
import type { NeedsYouRow } from '@/lib/needs-you/types'
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

const KINDS: Array<Pick<NeedsYouRow, 'kind' | 'group'> & { sentence: string; label: string }> = [
  { kind: 'follow_up_due', group: 'follow_up', sentence: 'You wrote to Dana 5 business days ago.', label: 'Review' },
  { kind: 'reply', group: 'reply', sentence: 'Marcus replied 2 days ago. You have not answered.', label: 'Review' },
  { kind: 'ready', group: 'ready', sentence: 'Ready to send.', label: 'Open' },
  { kind: 'approve_email', group: 'approval', sentence: 'An email is ready for you to approve.', label: 'Approve' },
]

/** n made-up Needs you rows, each about one fixture role. The list is given out of order on purpose: the section orders it. */
export function fixtureNeedsYou(n: number): NeedsYouRow[] {
  return fixtureRoles(n, Math.max(n, 1)).map((r, i) => {
    const k = KINDS[i % KINDS.length]
    return {
      id: `need-${i}`,
      kind: k.kind,
      group: k.group,
      target: { kind: 'role', id: r.id },
      companyId: r.companyId,
      companyName: r.company,
      logoUrl: null,
      roleTitle: r.title,
      sentence: k.sentence,
      dueAt: null,
      button: { label: k.label, command: 'roles.open' },
      count: 1,
      members: [],
    }
  })
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
    needs: [],
    now: NOW,
    ...over,
  }
}
