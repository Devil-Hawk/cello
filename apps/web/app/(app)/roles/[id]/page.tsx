import { notFound, redirect } from 'next/navigation'
import { RecordView } from '@/components/roles/record/record-view'
import { createClient } from '@/lib/supabase/server'
import { readRecord } from './read'

export const dynamic = 'force-dynamic'

// One role in full, as its own page. A role the person has no row for is a 404:
// the page never reveals whether the role exists for someone else.
export default async function RecordPage({ params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const data = await readRecord(supabase, user.id, params.id)
  if (!data) notFound()
  return <RecordView data={data} />
}
