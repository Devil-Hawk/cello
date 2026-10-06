// Chat is hidden until its measures pass (lib/chat/shown.ts). Everyone else lands on Today.
// ponytail: Today is /dashboard until the shell's Today route exists.

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { chatOpen } from '@/lib/chat/shown'
import { createClient } from '@/lib/supabase/server'

/** The signed in person's name for the rail, once Chat is open for them. */
export async function requireChat(): Promise<{ name: string }> {
  const {
    data: { user },
  } = await (await createClient()).auth.getUser()
  const db = createAdminClient()
  if (!user || !(await chatOpen(db, user.id))) redirect('/dashboard')
  const { data } = await db.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
  return { name: (data as { full_name: string | null } | null)?.full_name?.trim() || '' }
}
