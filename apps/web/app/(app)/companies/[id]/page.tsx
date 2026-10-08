import { notFound, redirect } from 'next/navigation'
import { CompanyView } from '@/components/companies/company-view'
import { parseCompanyQuery } from '@/components/companies/company-logic'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { readCompany, readLive, resolveCompany } from './read'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Company' }

// One employer, by a directory id or the person's own id. A directory employer opens whether or not the person
// follows it; the address is the whole state (the search, the open list, its filters and page).
export default async function CompanyPage({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const resolved = await resolveCompany(supabase, createAdminClient(), user.id, params.id)
  if (resolved.kind === 'missing') notFound()
  if (resolved.kind === 'redirect') redirect(resolved.to)
  const query = parseCompanyQuery(searchParams)
  const data = await readCompany(supabase, user.id, resolved)
  // The employer's whole list is read live only when the address asks for it, so the first screen reads stored rows and nothing else.
  const live = resolved.kind === 'directory' && (query.all || query.q) ? await readLive(supabase, user.id, resolved.employer, resolved.own, query) : null
  return <CompanyView data={data} query={query} live={live} />
}
