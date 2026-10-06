// GET /api/conversations/[id]/body: "Read all", fetched from Gmail when it is opened. The body is never stored.
// The text comes back as plain text for the page to show as text, never as markup.

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { fetchGmailThread } from '@/lib/gmail/gmail-api'
import { getGmailAccessToken } from '@/lib/gmail/token'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX = 20_000

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const client = await createClient()
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That message is gone.' }, { status: 404 })
  const { data } = await (client as unknown as SupabaseClient).from('messages').select('gmail_message_id, thread_id').eq('id', params.id).eq('user_id', user.id).maybeSingle()
  const row = data as { gmail_message_id: string; thread_id: string | null } | null
  if (!row?.thread_id) return NextResponse.json({ error: 'That message is gone.' }, { status: 404 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from('profiles').select('preferences').eq('id', user.id).maybeSingle()
  const token = await getGmailAccessToken(admin, user.id, ((profile as { preferences?: Record<string, unknown> } | null)?.preferences ?? {}) as Record<string, unknown>)
  if (!token.ok) return NextResponse.json({ error: 'Gmail needs you to sign in again.', code: 'reconnect' }, { status: 409 })
  const thread = await fetchGmailThread(token.accessToken, row.thread_id)
  const message = thread?.find((m) => m.id === row.gmail_message_id)
  if (!message) return NextResponse.json({ error: 'Gmail did not give that message. It may have been deleted.' }, { status: 404 })
  return NextResponse.json({ text: (message.payload.text ?? '').slice(0, MAX) })
}
