// GET /api/agent/threads/[id]/state: a saved conversation, for the hook's initial values after
// a page reload: { values: { messages }, interrupts }. Only the owner can read it, and someone
// else's conversation answers the same as a missing one.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { readSavedConversation } from '@/lib/agents/api'
import { AGENT_COPY } from '@/lib/agents/copy'
import { withAgentPersistence } from '@/lib/agents/persistence'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized', message: AGENT_COPY.signIn }, { status: 401 })

  const admin = createAdminClient()
  const { data } = await admin.from('graph_threads').select('thread_id, user_id, surface').eq('thread_id', params.id).maybeSingle()
  const thread = data as { thread_id: string; user_id: string; surface: string } | null
  if (!thread || thread.user_id !== user.id) return NextResponse.json({ error: 'not_found', message: AGENT_COPY.notFound }, { status: 404 })
  if (thread.surface === 'copilot') return NextResponse.json({ error: 'old_conversation', message: AGENT_COPY.oldConversation }, { status: 409 })

  // Only the checkpointer is read, so no model key is needed.
  const saved = await withAgentPersistence(({ saver }) => readSavedConversation(saver, thread.thread_id))
  return NextResponse.json(saved, { headers: { 'Cache-Control': 'no-store' } })
}
