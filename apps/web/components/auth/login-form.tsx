'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DemoCodeForm } from '@/components/auth/demo-code-form'
import { MarkTwin } from '@/components/depth/twins'
import { Key } from '@/components/ui/key'
import { createClient } from '@/lib/supabase/client'
import { today } from '@/lib/routes'

export type LoginNotice = 'cancelled' | 'demo-expired' | null

export const LOGIN_LINE =
  'Cello finds roles that fit you and keeps track of your search. Nothing is sent without your click.'

const NOTICES: Record<Exclude<LoginNotice, null>, string> = {
  cancelled: 'Sign-in was cancelled. Try again.',
  'demo-expired':
    'That code is not valid or has expired. Ask whoever gave it to you for a new one, or sign in to use Cello with your own account.',
}

/** What to say when email and password sign-in fails. */
export function signInMessage(err: { message?: string; status?: number }): string {
  if (err.status === 400 || /invalid login credentials/i.test(err.message ?? '')) {
    return 'That email and password do not match.'
  }
  return 'Could not sign in. Check your connection and try again.'
}

export function LoginForm({ notice, openDemo }: { notice: LoginNotice; openDemo: boolean }) {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [googleBusy, setGoogleBusy] = useState(false)
  const [emailBusy, setEmailBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault()
    setEmailBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(signInMessage(error))
      setEmailBusy(false)
      return
    }
    router.push(today.href)
    router.refresh()
  }

  async function signInWithGoogle() {
    setGoogleBusy(true)
    setError(null)
    try {
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          // Identity ONLY. Signing in must never demand mailbox access: mail
          // permissions are requested later, one tier at a time, where the
          // person can see what each one lets Cello do (lib/gmail/permissions.ts).
          queryParams: { access_type: 'offline' },
        },
      })
    } catch {
      setError('Could not reach Google. Try again.')
      setGoogleBusy(false)
    }
  }

  const shown = error ?? (notice ? NOTICES[notice] : null)
  const busy = googleBusy || emailBusy

  return (
    <main id="main-content" className="flex min-h-screen items-center justify-center bg-r-ground px-4 py-10 font-r text-r-ink">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <MarkTwin size={44} />
          <h1 className="r-section">Sign in to Cello</h1>
          <p className="r-body text-r-ink-2">{LOGIN_LINE}</p>
        </div>

        <div className="r-sheet space-y-5">
          <Key variant="raised" onClick={signInWithGoogle} disabled={busy} className="w-full">
            <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden>
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            {googleBusy ? 'Signing in' : 'Continue with Google'}
          </Key>

          <p className="r-meta text-center" aria-hidden>
            or
          </p>

          <form onSubmit={signInWithEmail} className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="email" className="r-meta">
                Email
              </label>
              <input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="r-field"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="r-meta">
                Password
              </label>
              <input
                id="password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="r-field"
                aria-invalid={error ? true : undefined}
                aria-describedby={shown ? 'login-notice' : undefined}
              />
            </div>
            {shown && (
              <p id="login-notice" role="alert" className="r-body text-r-ink">
                {shown}
              </p>
            )}
            <Key type="submit" disabled={busy} className="w-full">
              {emailBusy ? 'Signing in' : 'Sign in'}
            </Key>
          </form>

          {/* A demo code opens an isolated demo workspace, never anyone's real account. */}
          <DemoCodeForm defaultOpen={openDemo} />
        </div>
      </div>
    </main>
  )
}
