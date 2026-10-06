import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { Database, Json } from '@cello/shared'
import { encrypt } from '@/lib/crypto'
import { applyGmailPermissionChange, fetchGrantedGoogleScopes, GMAIL_PERMISSION_SCOPES } from '@/lib/gmail/permissions'
import type { SyncState } from '@/lib/gmail/types'
import { safeNextPath } from '@/lib/auth/safe-next'

const MONITOR_SCOPE = GMAIL_PERMISSION_SCOPES.monitor as string
const SEND_SCOPE = GMAIL_PERMISSION_SCOPES.send as string

/**
 * The ONLY point in the app that ever sees a Google `provider_refresh_token`
 * — Supabase hands it back exactly once, on this redirect, and never again
 * (provider_token itself is dead within about an hour and nothing refreshes
 * it in the background). If this session's grant includes gmail.readonly
 * (the "monitor mailbox" tier, see lib/gmail/permissions.ts) or gmail.send
 * (the "send approved messages" tier, which needs the token just as much to
 * send once the one-hour session token is gone), persist the
 * refresh token here, encrypted with the same helper api_keys uses, and
 * record the grant through applyGmailPermissionChange in the SAME write so
 * the stored permission state and the token that makes it usable never
 * drift apart. lib/gmail/token.ts is the other end: it exchanges this token
 * for access tokens later, and self-heals (monitor off, revokedAt set) the
 * day Google refuses it.
 *
 * Best-effort and silent on failure: a user who signed in with Google for
 * identity only (the common case — see app/login/page.tsx) has no refresh
 * token to find here at all, and a demo profile's write is refused by the
 * database lockdown trigger (supabase/migrations/20260803000003 guards the
 * whole `gmail_sync` key) — neither should ever block the redirect that
 * follows.
 */
async function persistGmailRefreshTokenIfGranted(
  supabase: ReturnType<typeof createServerClient<Database>>,
  userId: string,
  providerToken: string | null | undefined,
  providerRefreshToken: string
): Promise<void> {
  try {
    const scopes = providerToken ? await fetchGrantedGoogleScopes(providerToken) : []
    // Either Gmail scope makes the token worth keeping: readonly for sync,
    // send for delivering approved outreach after the session token is gone.
    if (!scopes.includes(MONITOR_SCOPE) && !scopes.includes(SEND_SCOPE)) return

    const { data: profile, error: readError } = await supabase
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .maybeSingle()
    if (readError) {
      console.error(`auth/callback: profile read failed before persisting Gmail token for ${userId} — ${readError.message}`)
      return
    }

    const now = new Date().toISOString()
    // Only the monitor tier is switched on here (it has always been recorded at
    // the redirect that grants it). The send flag stays the user's own toggle in
    // Settings; this only makes sure the token it relies on exists.
    const withGrant = scopes.includes(MONITOR_SCOPE)
      ? applyGmailPermissionChange(profile?.preferences ?? null, 'monitor', true, now)
      : ((profile?.preferences ?? {}) as Record<string, unknown>)
    const existingSync = (withGrant.gmail_sync || {}) as SyncState
    const nextPreferences = {
      ...withGrant,
      gmail_sync: { ...existingSync, refreshToken: encrypt(providerRefreshToken), revokedAt: null } satisfies SyncState,
    }

    const { error: writeError } = await supabase
      .from('profiles')
      .update({ preferences: nextPreferences as unknown as Json })
      .eq('id', userId)
    if (writeError) {
      // Covers the demo lockdown trigger refusing a `gmail_sync` change
      // (42501) as much as any ordinary write failure — either way this is
      // best-effort, never fatal to sign-in.
      console.error(`auth/callback: failed to persist Gmail refresh token for ${userId} — ${writeError.message}`)
    }
  } catch (err) {
    console.error('auth/callback: unexpected error persisting Gmail refresh token', err)
  }
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')

  // Google sent the person back with an error and no code: they backed out.
  // Say so on the sign-in page instead of dropping them on a page that bounces.
  if (!code && requestUrl.searchParams.get('error')) {
    return NextResponse.redirect(new URL('/login?error=cancelled', request.url))
  }

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set(name: string, value: string, options: CookieOptions) {
            cookieStore.set({ name, value, ...options })
          },
          remove(name: string, options: CookieOptions) {
            cookieStore.delete(name)
          },
        },
      }
    )
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error && data.user && data.session?.provider_refresh_token) {
      await persistGmailRefreshTokenIfGranted(
        supabase,
        data.user.id,
        data.session.provider_token,
        data.session.provider_refresh_token
      )
    }
  }

  // Back to where the sign-in started (Settings, for the incremental Gmail
  // grant), or the dashboard. Same-origin paths only.
  return NextResponse.redirect(new URL(safeNextPath(requestUrl.searchParams.get('next')), request.url))
}
