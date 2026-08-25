'use client'

import { LogoMark } from '@/components/brand/logo'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Briefcase, Building2, Send, LineChart } from 'lucide-react'

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault()
    setEmailLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setEmailLoading(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  async function signInWithGoogle() {
    setIsLoading(true)
    try {
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          // Identity ONLY. Signing in must never demand mailbox access — that
          // consent screen was the first thing a new user saw, before a single
          // product screen, and it defeated the whole point of splitting Gmail
          // into separate grants. Mail permissions are requested later, one
          // tier at a time, from Settings, where the user can see what each one
          // lets Cello do. See lib/gmail/permissions.ts.
          queryParams: {
            access_type: 'offline',
          },
        },
      })
    } catch (error) {
      console.error('Error signing in:', error)
      setIsLoading(false)
    }
  }

  const channels = [
    { icon: Building2, name: 'Watchlist', text: 'Track the companies you care about' },
    { icon: Briefcase, name: 'Match', text: 'AI-scored fit on every open role' },
    { icon: Send, name: 'Outreach', text: 'AI-drafted intros — you approve every send' },
    { icon: LineChart, name: 'Pipeline', text: 'A board that stays honest' },
  ]

  return (
    <div className="flex min-h-screen">
      {/* Left side - brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden border-r bg-sunken p-12 lg:flex">
        <div aria-hidden className="instrument-ruling absolute inset-0 opacity-60" />

        {/* Wordmark */}
        <div className="relative flex items-center gap-2.5">
          <LogoMark className="h-8 w-8" />
          <span className="font-display text-title text-foreground">Cello</span>
        </div>

        <div className="relative space-y-10">
          <div className="space-y-4">
            <p className="font-readout text-label uppercase tracking-[0.16em] text-muted-foreground">
              Career engine · leads &amp; opportunities
            </p>
            <h1 className="max-w-md font-display text-display text-foreground">
              A calm, honest home for your job search.
            </h1>
            <p className="max-w-md text-body text-muted-foreground">
              Cello tracks opportunities, watches company boards, and keeps your
              pipeline moving — so you can focus on the conversations.
            </p>
          </div>

          {/* Instrument channels */}
          <ul className="max-w-md divide-y overflow-hidden rounded-card border bg-card shadow-card">
            {channels.map((channel) => (
              <li key={channel.name} className="flex items-center gap-3.5 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border bg-raised text-accent-deep shadow-raised">
                  <channel.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="font-readout text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
                    {channel.name}
                  </p>
                  <p className="text-body text-foreground">{channel.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-caption text-muted-foreground">
          Your data stays yours. Credentials are encrypted, and nothing is sold or
          used to train models. Cello runs on your own AI keys, so the work you ask
          for is processed by the providers you connect — and nothing else leaves.
        </p>
      </div>

      {/* Right side - login form */}
      <div className="flex flex-1 items-center justify-center bg-background p-8">
        <div className="w-full max-w-sm space-y-8">
          {/* Mobile wordmark */}
          <div className="flex flex-col items-center gap-1 lg:hidden">
            <div className="flex items-center gap-2">
              <LogoMark className="h-7 w-7" />
              <span className="font-display text-title text-foreground">Cello</span>
            </div>
            <p className="text-caption text-muted-foreground">
              Career engine for leads &amp; opportunities
            </p>
          </div>

          <div className="rounded-card border bg-card p-8 shadow-card">
            <div className="space-y-6">
              <div className="space-y-1 text-center">
                <h2 className="font-display text-title text-foreground">Welcome back</h2>
                <p className="text-caption text-muted-foreground">
                  Sign in to continue your job search
                </p>
              </div>

              <Button
                variant="outline"
                onClick={signInWithGoogle}
                disabled={isLoading}
                className="h-10 w-full"
              >
                {isLoading ? (
                  <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
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
                )}
                Continue with Google
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 text-label uppercase text-muted-foreground">
                    or use your email
                  </span>
                </div>
              </div>

              <form onSubmit={signInWithEmail} className="space-y-3">
                <Input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Email"
                  className="h-10"
                />
                <Input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  className="h-10"
                />
                {error && (
                  <p className="text-center text-caption text-destructive">{error}</p>
                )}
                <Button type="submit" disabled={emailLoading} className="h-10 w-full">
                  {emailLoading ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    'Sign in'
                  )}
                </Button>
              </form>

              <p className="text-center text-caption text-muted-foreground">
                Credentials encrypted. Never sold, never used for training.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
