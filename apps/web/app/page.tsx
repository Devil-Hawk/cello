import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Landing } from '@/components/brand/landing/landing'
import { today } from '@/lib/routes'

// Force dynamic rendering since we need cookies
export const dynamic = 'force-dynamic'

// Signed in goes to Today. Anyone else sees Landing; middleware treats this
// exact address as public.
export default async function HomePage() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()

  if (session) redirect(today.href)

  return <Landing />
}
