import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { SCREENS, type Screen } from './_parts/logic'
import { WelcomeFlow } from './welcome-flow'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Welcome' }

// First run. Whether this is a demo is read here, on the server, so a demo is
// never shown a screen that asks for a key, however it got to this address.
export default async function WelcomePage({ searchParams }: { searchParams: { screen?: string } }) {
  const supabase = (await createClient()) as unknown as SupabaseClient
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let demo = true
  let name = ''
  let hasResume = false
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_demo, demo_expires_at, full_name, resume_text')
      .eq('id', user.id)
      .maybeSingle()
    // Anything unreadable counts as a demo: the safe side of "never ask a demo for a key".
    if (profile) demo = profile.is_demo !== false || profile.demo_expires_at != null
    name = (profile?.full_name as string | null) || (user.user_metadata?.full_name as string | undefined) || ''
    hasResume = Boolean((profile?.resume_text as string | null)?.trim())
  }

  const asked = searchParams.screen as Screen | undefined
  const start: Screen = asked && SCREENS.includes(asked) ? asked : 'resume'
  return <WelcomeFlow demo={demo} initialName={name} hasResume={hasResume} start={start} />
}
