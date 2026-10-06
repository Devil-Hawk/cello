// POST /api/agent/stream: one turn of the conversation, streamed for the useStream hook.
//
// Body (what the hook's transport sends): { input?: { messages: [{ type: 'human', content }] },
// command?: { resume }, context?: { conversationId } }. New words use `input`; an answer to a
// question Cello asked uses `command.resume`; a new conversation is one with no conversationId.
//
// Everything that can be refused is refused before the first byte, as JSON with a status the
// UI can act on and one plain sentence in `message` (401 sign in, 402 add a key, 403 demo
// ended, 404 not found, 409 busy or an earlier-Copilot conversation). After that the response
// is an event stream; its first event is `metadata` with the conversation id.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { AGENT_COPY } from '@/lib/agents/copy'
import { executeTurn } from '@/lib/agents/run'
import { toSseResponse } from '@/lib/agents/sse'
import { traced } from '@/lib/agents/traced'
import { openUserTurn, StreamBodySchema } from '@/lib/agents/turn'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized', message: AGENT_COPY.signIn }, { status: 401 })

  const parsed = StreamBodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'empty', message: 'Write a message to send.' }, { status: 400 })

  const admin = createAdminClient()
  const opened = await openUserTurn({ admin, user, body: parsed.data, signal: request.signal })
  if (!opened.ok) return NextResponse.json({ error: opened.error, message: opened.message }, { status: opened.status })

  const { ctx, lease, mode } = opened
  return toSseResponse(async (emit) => {
    await traced(admin, user.id, { name: 'agent-turn', sessionId: ctx.conversationId }, async (traceId) => {
      ctx.traceId = traceId
      await executeTurn({ ctx, lease, mode, emit, sessionId: ctx.conversationId })
    })
  }, request.signal)
}
