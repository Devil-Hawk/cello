import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isOwner } from '@/lib/measures/owner'
import { SettingsView } from '@/components/settings/settings-view'

export const metadata = { title: 'Settings' }

// Settings in the sections of blueprint 4.12. The owner flag decides one part (Demo codes) and is read here, on the
// server, from the session; the codes themselves are guarded again by their own routes.
export default async function Page({ searchParams }: { searchParams: { tab?: string } }) {
  // The targeting tab moved to Your search.
  if (searchParams.tab === 'targeting') redirect('/search')
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return (
    <Suspense fallback={null}>
      <SettingsView owner={isOwner(user?.id)} />
    </Suspense>
  )
}
