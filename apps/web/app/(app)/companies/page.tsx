import { redirect } from 'next/navigation'
import { CompaniesView } from '@/components/companies/companies-view'
import { parseCompaniesQuery } from '@/components/companies/logic'
import { createClient } from '@/lib/supabase/server'
import { readCompanies } from './read'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Companies' }

// Companies: every employer Cello has verified, whether or not the person follows it. Server rendered, so the
// address is the whole state (tab, filters, page, the open row) and Back returns to the list where it was.
export default async function CompaniesPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const query = parseCompaniesQuery(searchParams)
  const data = await readCompanies(supabase, user.id, query)
  return <CompaniesView query={query} {...data} />
}
