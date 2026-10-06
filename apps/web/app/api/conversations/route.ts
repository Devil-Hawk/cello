// GET /api/conversations: what waits on the person (replies, new mail from recruiters, people to write to).
// POST { command, input }: conversations.handled, "I have handled this".

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { conversationsCommands } from '@/lib/commands/defs/people'
import { sessionDoor } from '@/lib/commands/doors'
import { commandDoor } from '@/lib/network/door'
import { readConversations } from '@/lib/network/conversations'
import { createClient } from '@/lib/supabase/server'

const door = commandDoor(conversationsCommands, sessionDoor)
export const dynamic = door.dynamic
export const POST = door.POST

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await readConversations(supabase as unknown as SupabaseClient, user.id))
  } catch {
    return NextResponse.json({ error: 'Could not read your conversations. Try again.' }, { status: 500 })
  }
}
