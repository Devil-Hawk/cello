import { parseCompanyQuery } from '@/components/companies/company-logic'
import { FIXTURE_NOW, fixturePreview } from '@/components/companies/fixtures'
import { PreviewView } from '@/components/companies/preview-view'
import { FixtureShell } from '../../_shell'

// The preview of one posting on made-up data, in the shell. Its own route so the Company fixture weighs what the
// Company page weighs (the record's components load only here, as they do on the real preview route).
export default function CompanyPreviewFixture({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  return (
    <FixtureShell pathname="/companies">
      <PreviewView data={fixturePreview} query={{ ...parseCompanyQuery(searchParams), all: true }} now={FIXTURE_NOW} />
    </FixtureShell>
  )
}
