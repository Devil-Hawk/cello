import { notFound, redirect } from 'next/navigation'
import { PreviewClosed, PreviewView } from '@/components/companies/preview-view'
import { RATE_LINE, companyPageHref, decodeKey, parseCompanyQuery } from '@/components/companies/company-logic'
import { getEmployer } from '@/lib/companies/directory'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { recordHref } from '@/lib/routes/roles'
import { createClient } from '@/lib/supabase/server'
import { ownFor, readPreview } from '../../read'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Role' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A role from an employer's whole list that the person has not kept. The address carries the employer's own key for
// the posting and never a link: the page finds the posting in its own live read of that employer, so a key that is
// not in the list, or a link from another host, is a 404. Nothing here is stored until the person acts, and a role
// they already hold opens on its record instead.
export default async function PreviewPage({ params, searchParams }: { params: { id: string; key: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!UUID.test(params.id)) notFound()
  const employer = await getEmployer(createAdminClient(), params.id)
  if (!employer) notFound()
  const key = decodeKey(params.key)
  if (key === null) notFound()
  const query = parseCompanyQuery(searchParams)
  const result = await readPreview(supabase, user.id, employer, await ownFor(supabase, user.id, employer.id), key)
  if (result.kind === 'held') redirect(recordHref(result.id))
  if (result.kind === 'missing') notFound()
  if (result.kind === 'limited') return <p className="r-body mx-auto max-w-[860px]">{RATE_LINE}</p>
  if (result.kind === 'closed') return <PreviewClosed company={result.company.name} back={companyPageHref(employer.id, query)} />
  return <PreviewView data={result.data} query={query} />
}
