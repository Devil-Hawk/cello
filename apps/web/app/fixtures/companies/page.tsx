import { CompaniesView } from '@/components/companies/companies-view'
import { FIXTURE_NOW, fixtureData } from '@/components/companies/fixtures'
import { addOutcome, parseCompaniesQuery, verifyingLine, type AddResponse, type AddState } from '@/components/companies/logic'
import { FixtureShell } from '../_shell'

// Companies on made-up employers, in the shell. ?n=0|1|50|51 sets how many rows the tab holds; the rest of the
// address is the page's own (?tab=following, ?focus=<id>). ?types=0 is a person with no role types, ?loading=1 the
// directory still being read, ?failed=1 a failed load, ?sponsor=1 a person who needs sponsorship, ?cannot=1 makes the
// second employer one Cello cannot read. ?add=verifying|added|already|limit|demo|other_owner|cannot_read
// opens Add or find in that state.

const OFFER = { kind: 'employer' as const, name: 'Retell AI', employerId: '30000000-0000-4000-8000-000000000001' }
const EMPLOYER = { employerId: '30000000-0000-4000-8000-000000000001', name: 'Retell AI', domain: 'retellai.com', logoUrl: null, openCount: 6 }

function addState(kind: string | undefined): AddState | undefined {
  const link = 'https://jobs.ashbyhq.com/retell-ai'
  const answers: Record<string, AddResponse> = {
    added: { ok: true, companyId: 'c', already: false, employer: EMPLOYER },
    already: { ok: true, companyId: 'c', already: true, employer: EMPLOYER },
    limit: { ok: false, reason: 'daily_limit' },
    demo: { ok: false, reason: 'demo' },
    other_owner: { ok: false, reason: 'other_owner', offers: [OFFER] },
    cannot_read: { ok: false, reason: 'cannot_read' },
  }
  if (kind === 'verifying') return { kind: 'verifying', line: verifyingLine({ link, name: 'Retell AI' }) }
  if (kind && answers[kind]) return addOutcome(answers[kind], { link, name: 'Retell AI' })
  return undefined
}

export default function CompaniesFixture({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const n = Number(searchParams.n ?? 26)
  const query = parseCompaniesQuery(searchParams)
  const data = fixtureData({
    n: Number.isFinite(n) ? Math.min(Math.max(n, 0), 51) : 26,
    query,
    sponsor: Boolean(searchParams.sponsor),
    cannot: Boolean(searchParams.cannot),
    types: searchParams.types !== '0',
    loading: Boolean(searchParams.loading),
    failed: Boolean(searchParams.failed),
  })
  return (
    <FixtureShell pathname="/companies">
      <CompaniesView query={query} {...data} now={FIXTURE_NOW} add={addState(searchParams.add)} />
    </FixtureShell>
  )
}
