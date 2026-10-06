'use client'

import { Shell } from '@/components/layout/shell'
import { fixtureCounts, fixtureRoles, employerId } from '@/components/roles/fixtures'
import { parseRolesQuery } from '@/components/roles/logic'
import { RolesView } from '@/components/roles/roles-view'

// Roles on made-up roles, in the shell. ?n=26&e=40 sets how many roles and
// employers; the rest of the address is Roles' own (?group=company, ?tab=saved).
// ?cannot=1 makes the first employer one Cello cannot read.
export default function RolesFixture({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const n = Math.min(Number(searchParams.n ?? 26), 300)
  const e = Math.min(Number(searchParams.e ?? 6), 100)
  const query = parseRolesQuery(searchParams)
  const items = fixtureRoles(Number.isFinite(n) ? n : 26, Number.isFinite(e) ? e : 6).map((i) => ({
    ...i,
    closed: query.tab === 'saved' && i.id.endsWith('2'),
    hiddenReason: query.tab === 'hidden' ? ('not_for_me' as const) : null,
  }))
  return (
    <Shell pathname="/roles" user={{ email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }} onSignOut={() => undefined}>
      <RolesView
        query={query}
        items={items}
        picks={[]}
        total={items.length}
        newToday={items.length > 0 ? Math.min(items.length, 41) : 0}
        groupCounts={fixtureCounts(items)}
        facts={{ [employerId(0)]: searchParams.cannot ? { open: null, cannotRead: 'it asked for a human check' } : { open: 636, cannotRead: null } }}
        outside={{ place: 120, title: 80, level: 14 }}
        checkLine="Checked 3 hours ago."
      />
    </Shell>
  )
}
