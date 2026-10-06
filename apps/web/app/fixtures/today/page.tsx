'use client'

import { Shell } from '@/components/layout/shell'
import { fixtureRoles } from '@/components/roles/fixtures'
import { fixtureSent, fixtureToday } from '@/components/today/fixtures'
import { TodayView } from '@/components/today/today-view'

// Today on made-up data, in the shell. ?state=first|failed|quiet|model, ?working=1 shows Working now,
// ?sent=8 sets how many applications were sent, ?gmail=0 takes Gmail read access away.
export default function TodayFixture({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const state = searchParams.state
  const sent = Math.min(Number(searchParams.sent ?? (state === 'quiet' ? 6 : 0)), 20)
  const data = fixtureToday({
    state: state === 'first' ? 'first' : state === 'failed' ? 'failed' : 'ready',
    band: state === 'quiet' || state === 'first' ? { kind: 'newest', items: [] } : { kind: 'newest', items: fixtureRoles(6, 6) },
    newCount: state === 'quiet' || state === 'first' ? 0 : 41,
    check: state === 'first' ? null : 'Checked 2 hours ago. Next check at 18:00 UTC.',
    working: Boolean(searchParams.working),
    since: state === 'first' ? null : { kept: 12, changes: [] },
    sent: Number.isFinite(sent) ? fixtureSent(sent) : [],
    canReadReplies: searchParams.gmail !== '0',
    hasModel: state !== 'model',
  })
  return (
    <Shell pathname="/today" user={{ email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }} onSignOut={() => undefined}>
      <TodayView data={data} />
    </Shell>
  )
}
