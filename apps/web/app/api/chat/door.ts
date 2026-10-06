// The door every Chat route goes through: a signed in person, with Chat open for them. Anything else gets the
// same answer a page that does not exist would give, so a closed Chat says nothing about what is behind it.
// ponytail: each route calls the lib/chat function directly; they become runCommand calls when the registry lands.

import { NextResponse } from 'next/server'
import { chatOpen } from '@/lib/chat/shown'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import type { AdminClient } from '@/lib/harness/types'
import { createClient } from '@/lib/supabase/server'

export interface ChatSession {
  userId: string
  db: AdminClient
}

export async function chatSession(): Promise<ChatSession | NextResponse> {
  const {
    data: { user },
  } = await (await createClient()).auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Sign in to use Chat.' }, { status: 401 })
  const db = createAdminClient()
  if (!(await chatOpen(db, user.id))) return new NextResponse(null, { status: 404 })
  return { userId: user.id, db }
}

export const isResponse = (v: ChatSession | NextResponse): v is NextResponse => v instanceof NextResponse

export const chatNotFound = () => NextResponse.json({ error: 'not_found', message: 'That chat was not found.' }, { status: 404 })

/** The request's JSON body, or null when it is not JSON. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const badRequest = (message: string) => NextResponse.json({ error: 'bad_request', message }, { status: 400 })
