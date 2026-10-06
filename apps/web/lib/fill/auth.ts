// Who is the extension, and may it. The extension holds a scoped token the person minted from the
// session (fill:extension); it can call the fill routes and Pause, and nothing else. Every route
// reads applications with the token owner's id, so a token never opens another person's application.

import { NextRequest, NextResponse } from 'next/server'
import { hashToken, validateToken } from '@/lib/access/tokens'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import type { SupabaseClient } from '@supabase/supabase-js'

export const FILL_SCOPE = 'fill:extension'

export interface FillAuth {
  admin: SupabaseClient
  userId: string
  tokenId: string
}

export async function fillAuth(request: NextRequest): Promise<FillAuth | NextResponse> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!bearer) return NextResponse.json({ error: 'Connect the extension first.' }, { status: 401 })
  const admin = createAdminClient() as unknown as SupabaseClient
  const v = await validateToken(admin as never, bearer)
  if (!v.ok || !v.userId || !v.scopes?.includes(FILL_SCOPE)) return NextResponse.json({ error: 'Connect the extension again.' }, { status: 401 })
  const { data } = await admin.from('api_tokens').select('id').eq('token_hash', hashToken(bearer)).maybeSingle()
  const tokenId = (data as { id: string } | null)?.id
  if (!tokenId) return NextResponse.json({ error: 'Connect the extension again.' }, { status: 401 })
  return { admin, userId: v.userId, tokenId }
}

export const isFillAuth = (v: FillAuth | NextResponse): v is FillAuth => !(v instanceof NextResponse)
