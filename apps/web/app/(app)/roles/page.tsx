import { redirect } from 'next/navigation'
import { RolesView } from '@/components/roles/roles-view'
import { parseRolesQuery } from '@/components/roles/logic'
import { createClient } from '@/lib/supabase/server'
import { readRoles } from './read'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Roles' }

// Roles: every role kept for the person. Server rendered, so the address is the
// whole state (tab, grouping, filters, how many rows) and Back returns to the list
// where it was.
export default async function RolesPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const query = parseRolesQuery(searchParams)
  const data = await readRoles(supabase, user.id, query)
  return <RolesView query={query} {...data} />
}
