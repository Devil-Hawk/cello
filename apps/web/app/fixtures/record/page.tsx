'use client'

import { Shell } from '@/components/layout/shell'
import { fixturePosting, fixtureRecord } from '@/components/roles/fixtures'
import { RecordView } from '@/components/roles/record/record-view'

// One role's record on made-up data, in the shell. ?chars=60000 sets the length of
// the posting, ?title= a long title, ?link=1 a posting that is only a link,
// ?applied=1 the state after applying.
export default function RecordFixture({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const base = fixtureRecord()
  const chars = Math.min(Number(searchParams.chars ?? 2400), 100_000)
  const data = fixtureRecord({
    role: { ...base.role, title: searchParams.title?.slice(0, 200) || base.role.title },
    description: searchParams.link ? 'https://vantageloom.example/careers/ai-engineer' : fixturePosting(Number.isFinite(chars) ? chars : 2400),
    status: searchParams.applied ? 'You applied on Sep 12.' : null,
    sponsorship: searchParams.visa ? ['The posting does not mention sponsorship.', 'Past H-1B filings.'] : [],
  })
  return (
    <Shell pathname="/roles/fx-1" user={{ email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }} onSignOut={() => undefined} bell={false}>
      <RecordView data={data} />
    </Shell>
  )
}
