import type { LiveData } from '@/app/(app)/companies/[id]/read'
import { CompanyView } from '@/components/companies/company-view'
import { parseCompanyQuery } from '@/components/companies/company-logic'
import { FIXTURE_NOW, fixtureCompany, fixtureLive } from '@/components/companies/fixtures'
import { fixtureRoles } from '@/components/roles/fixtures'
import { FixtureShell } from '../_shell'

// One Company on made-up data, in the shell. ?n=0|1|25|26|636 sets how many roles the employer lists; the address is
// the page's own (?all=1 opens the whole list, ?q=forward searches it, ?p=2 is the third page). ?cannot=1 is a site
// Cello cannot read, ?rendered=1 one it reads only in the background, ?email=1 an employer known only from mail,
// ?follow=0 an employer the person does not follow. The preview of one posting is /fixtures/company/preview.
export default function CompanyFixture({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const query = parseCompanyQuery(searchParams)
  const n = Number(searchParams.n ?? 636)
  const count = Number.isFinite(n) ? Math.min(Math.max(n, 0), 5000) : 636

  const cannot = Boolean(searchParams.cannot)
  const data = searchParams.email
    ? fixtureCompany({ state: 'email', employerId: null, id: '20000000-0000-4000-8000-000000000009', open: null, forYou: 0, kept: [], field: null, facts: [], following: false, check: null, appliedAt: '2026-03-14T09:00:00.000Z' })
    : fixtureCompany({
        ...(cannot ? { cannotRead: 'no_board', open: null } : {}),
        ...(searchParams.rendered ? { tier: 'rendered' } : {}),
        ...(searchParams.follow === '0' ? { following: false, companyId: null, remove: null } : {}),
      })

  let live: LiveData | null = null
  if (!searchParams.email && (query.all || query.q)) {
    const base = fixtureLive(count, query.page)
    const words = (query.q ?? '').toLowerCase().split(' ').filter(Boolean)
    const items = words.length > 0 ? base.items.filter((i) => words.every((w) => i.title.toLowerCase().includes(w))) : base.items
    live = cannot
      ? { ...base, items: [], total: 0, kept: 0, matched: 0, pages: 1, counts: {}, keptBefore: fixtureRoles(2, 1).map((r) => ({ ...r, company: data.name, companyId: data.id })) }
      : searchParams.rendered
        ? { ...base, items: [], rendered: true }
        : { ...base, items, ...(words.length > 0 ? { matched: items.length, pages: 1, page: 0 } : {}) }
  }

  return (
    <FixtureShell pathname="/companies">
      <CompanyView data={data} query={query} live={live} now={FIXTURE_NOW} />
    </FixtureShell>
  )
}
