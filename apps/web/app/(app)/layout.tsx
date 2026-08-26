'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchClientSafePreferences } from '@/lib/preferences/client-safe'
import { Sidebar } from '@/components/layout/sidebar'
import { Header } from '@/components/layout/header'
import { MobileNav } from '@/components/layout/mobile-nav'
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
  // Set only when the auth check itself throws (network error, Supabase
  // outage, ...) — distinct from "no user" (a real signed-out redirect).
  // Bumping retryToken re-runs the effect below without a full page reload.
  const [authError, setAuthError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  // Below `md` the sidebar is an off-canvas drawer instead of the always-on
  // rail (see sidebar.tsx) — this is the one piece of state both Header (the
  // hamburger that opens it) and Sidebar (the drawer + its own close
  // affordances) need to share, so it lives here, their common parent.
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)
  // The hamburger button in Header — focus returns here when the drawer
  // closes (Escape, backdrop click, or picking a nav link), matching how
  // job-detail-modal.tsx restores focus to whatever opened it.
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  // A route change is itself a form of "navigation happened" — never leave
  // the drawer open over the newly-loaded page.
  useEffect(() => {
    setIsMobileNavOpen(false)
  }, [pathname])

  function closeMobileNav() {
    setIsMobileNavOpen(false)
    menuButtonRef.current?.focus()
  }

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

        // First-login flow: brand-new users (never onboarded, no companies yet)
        // land on the onboarding wizard. Best-effort — never blocks rendering.
        if (pathname !== '/onboarding') {
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
              const { count } = await supabase
                .from('companies')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', user.id)
              if (!count) router.push('/onboarding')
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
  }

  return (
    <AppMotionConfig>
      {/* Keyboard-only skip link: invisible until focused, jumps straight past
          the sidebar + header nav to the page content. First tab stop in the
          whole shell. */}
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-[200] focus-visible:rounded-control focus-visible:bg-accent focus-visible:px-4 focus-visible:py-2 focus-visible:text-accent-foreground focus-visible:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to main content
      </a>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar
          user={userInfo}
          onSignOut={handleSignOut}
          isMobileOpen={isMobileNavOpen}
          onCloseMobile={closeMobileNav}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* md:hidden inside Header itself — at md+ the sidebar rail is the
              entire desktop shell's chrome, so there is no horizontal band
              here at all above `<main>`, just the hamburger-only bar below
              md (see header.tsx). Nothing here needs to change to make room
              for that: Header still renders its own height (0 at md+, since
              the element itself is display:none) as a normal flex child, so
              <main> below simply gets the rest of this column either way. */}
          <Header
            menuButtonRef={menuButtonRef}
            onOpenNav={() => setIsMobileNavOpen(true)}
          />
          <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none focus-visible:ring-0">
            {/* Padding scales down at small widths — a flat px-8 py-8 left
                a 390px-wide screen with almost no room for content.
                No max-width here on purpose — width is the content's
                decision, not the shell's. The kanban board, jobs table, and
                insights grid all want the full rail-to-edge space; a surface
                that wants a prose measure caps itself (see the copilot
                transcript's own max-w-[75ch]) instead of the shell clamping
                every page to a long-form-reading width. */}
            <div className="mx-auto w-full px-4 py-5 sm:px-6 sm:py-6 md:px-8 md:py-8">
              {/* Keyed by pathname: a short, non-blocking enter on every
                  route change. No exit animation (no AnimatePresence) so a
                  slow page can never leave the previous one half-faded. */}
              <motion.div
                key={pathname}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={transitionFast}
              >
                {children}
              </motion.div>
            </div>
          </main>
          {/* Bottom tab bar, small screens only (see mobile-nav.tsx) — a
              normal flex child (not fixed/overlay), so it takes real space
              out of this column and `<main>` above never renders content
              underneath it. */}
          <MobileNav />
        </div>
      </div>
    </AppMotionConfig>
  )
}
