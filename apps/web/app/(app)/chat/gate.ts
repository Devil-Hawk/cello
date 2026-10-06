// Chat is hidden until its measures pass (lib/chat/shown.ts). Everyone else lands on Today.
// ponytail: Today is /dashboard until the shell's Today route exists.

import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { chatOpen } from '@/lib/chat/shown'
import { createClient } from '@/lib/supabase/server'

export async function requireChat(): Promise<void> {
  const {
    data: { user },
  } = await (await createClient()).auth.getUser()
  if (!(await chatOpen(createAdminClient(), user?.id))) redirect('/dashboard')
}
