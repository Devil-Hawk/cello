'use client'

import { trackedOnly } from '@/lib/companies/watchlist'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchClientSafePreferences } from '@/lib/preferences/client-safe'
import { Shell } from '@/components/layout/shell'
import { welcome } from '@/lib/routes'
import { AppMotionConfig, motion, transitionFast } from '@/components/ui/motion'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import type { User } from '@supabase/supabase-js'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Chat shows in the bar only for a person it is open for; its API answers 404 for anyone else.
  const [chatOpen, setChatOpen] = useState(false)
  // Set only when the auth check itself throws (network error, Supabase
  // outage, ...) — distinct from "no user" (a real signed-out redirect).
  // Bumping retryToken re-runs the effect below without a full page reload.
  const [authError, setAuthError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  useEffect(() => {
    async function getUser() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          router.push('/login')
          return
        }
        setUser(user)
        setAuthError(null)
        void fetch('/api/chat?limit=1', { cache: 'no-store' }).then((r) => setChatOpen(r.ok), () => undefined)

        // First-login flow: brand-new users (never onboarded, no companies yet)
        // land on Welcome. Best-effort — never blocks rendering.
        if (pathname !== welcome.href) {
          try {
            // NEVER supabase.from('profiles').select('preferences') here.
            //
            // PostgREST has no jsonb-path projection, so select('preferences')
            // returns the WHOLE column — api_keys for every provider, plus
            // autopilot.atsKeys, which an audit found has never been encrypted
            // at all. This layout wraps the entire (app) route group, so doing
            // that here shipped every one of those values to the browser on
            // EVERY authenticated page load, reachable by any script running in
            // the page: an XSS, a compromised extension, a bad client-bundle
            // dependency. It is the single highest-volume instance of the leak.
            //
            // The RPC returns a fixed, enumerable set of safe keys built with
            // jsonb_build_object — not "preferences minus some keys" — so a new
            // secret added to that column can never start flowing here later.
            // See lib/preferences/client-safe.ts and migration
            // 20260803000005_profiles_column_privileges.sql.
            const prefs = await fetchClientSafePreferences(
              supabase as unknown as SupabaseClient
            )
            if (!prefs?.onboardedAt) {
              const { count } = await trackedOnly(
                supabase.from('companies').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
              )
              if (!count) router.push(welcome.href)
            }
          } catch {
            /* onboarding redirect is best-effort */
          }
        }
      } catch (err) {
        // supabase.auth.getUser() itself failed — this used to be uncaught,
        // so setIsLoading(false) never ran and the user was stuck on the
        // spinner forever (reproduced in a real browser: 45s on an empty
        // main, no message, no retry). Surface a retry instead of hanging.
        setAuthError(
          err instanceof Error
            ? err.message
            : 'The sign-in check failed to respond. Check your connection and try again.'
        )
      } finally {
        // In a `finally`, not per-branch: the `if (!user) return` path above
        // pushes to /login and returns, and if that navigation never completes
        // (middleware bounce, offline) a per-branch call leaves isLoading true
        // forever — the same stuck-spinner failure, just relocated behind the
        // redirect-in-progress branch.
        setIsLoading(false)
      }
    }
    getUser()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, supabase, retryToken])

  function retryAuthCheck() {
    setAuthError(null)
    setIsLoading(true)
    setRetryToken((n) => n + 1)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-foreground" />
      </div>
    )
  }

  if (authError) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4">
        <EmptyState
          icon={AlertTriangle}
          headingLevel="h1"
          title="Couldn't verify your session"
          body={authError}
          className="max-w-md"
          action={<Button onClick={retryAuthCheck}>Try again</Button>}
        />
      </div>
    )
  }

  if (!user) {
    // getUser() found no session and is already redirecting to /login (see
    // the effect above) — hold here instead of rendering a blank main for
    // the instant before that navigation completes.
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-foreground" />
      </div>
    )
  }

  const userInfo = {
    email: user.email || '',
    fullName: user.user_metadata?.full_name || user.user_metadata?.name || null,
    avatarUrl: user.user_metadata?.avatar_url || null,
    chatOpen,
  }

  return (
    <AppMotionConfig>
      <Shell pathname={pathname} user={userInfo} onSignOut={handleSignOut}>
        {/* Keyed by pathname: a short, non-blocking enter on every route change.
            No exit animation (no AnimatePresence) so a slow page can never leave
            the previous one half-faded. */}
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitionFast}
        >
          {children}
        </motion.div>
      </Shell>
    </AppMotionConfig>
  )
}
