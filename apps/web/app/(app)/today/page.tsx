import { redirect } from 'next/navigation'
import { TodayView } from '@/components/today/today-view'
import { createClient } from '@/lib/supabase/server'
import { readToday } from './read'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Today' }

// Today: the first page after sign-in. Reading it stamps the visit, so the next
// one can say what changed since.
export default async function TodayPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const data = await readToday(supabase, user.id)
  return <TodayView data={data} />
}
