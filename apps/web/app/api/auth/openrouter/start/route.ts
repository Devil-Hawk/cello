import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { PKCE_COOKIE, PKCE_COOKIE_PATH, PKCE_MAX_AGE_SECONDS, authUrl, challengeFor, makeVerifier, safeReturn } from '../pkce'

export const dynamic = 'force-dynamic'

// GET /api/auth/openrouter/start?return=/welcome
// Starts the PKCE round trip: a verifier in an httpOnly cookie, then OpenRouter's
// sign-in page with the challenge. Only a signed-in person gets this far.
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  const verifier = makeVerifier()
  const back = safeReturn(request.nextUrl.searchParams.get('return'))
  const response = NextResponse.redirect(authUrl(request.nextUrl.origin, challengeFor(verifier)))
  response.cookies.set(PKCE_COOKIE, JSON.stringify({ v: verifier, r: back }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: PKCE_COOKIE_PATH,
    maxAge: PKCE_MAX_AGE_SECONDS,
  })
  return response
}
