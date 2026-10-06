// Copilot is Chat once Chat is shown to everyone (the switch the owner turns on after the measures pass): old links and
// bookmarks forward on, carrying a typed question. Until then this is the page that works, so it stays.
// ponytail: the old page lives on as legacy.tsx until the switch is on; delete it, components/copilot and
// app/api/copilot together after that.

import { redirect } from 'next/navigation'
import { chatShownToAll } from '@/lib/chat/shown'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import LegacyCopilot from './legacy'

export const dynamic = 'force-dynamic'

export default async function CopilotPage({ searchParams }: { searchParams: { ask?: string; conversationId?: string } }) {
  // A link from Chat's Earlier list names an old conversation: that is the one case this page still opens.
  if (!searchParams.conversationId && (await chatShownToAll(createAdminClient()))) redirect(searchParams.ask ? `/chat?ask=${encodeURIComponent(searchParams.ask)}` : '/chat')
  return <LegacyCopilot />
}
