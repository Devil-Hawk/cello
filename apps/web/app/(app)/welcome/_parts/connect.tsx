'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import { createClient } from '@/lib/supabase/client'
import { GMAIL_PERMISSION_SCOPES, INCREMENTAL_OAUTH_QUERY_PARAMS } from '@/lib/gmail/permissions'
import { welcome } from '@/lib/routes'

const GMAIL_LINE =
  'Cello finds your past applications from job mail, and tracks replies as they arrive. It never sends without your click.'

// Screen 3: connect Gmail, and how Cello may think. Both are optional and both
// end in a plain "Not now". A demo never reaches this screen.
export function ConnectScreen({ onDone }: { onDone: () => void }) {
  const supabase = createClient()
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelChoice, setModelChoice] = useState<'key' | 'none' | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/gmail/permissions')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { permissions?: { monitor?: { enabled?: boolean } } } | null) => {
        if (live && d?.permissions?.monitor?.enabled) setConnected(true)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  async function connectGmail() {
    setBusy(true)
    setError(null)
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(`${welcome.href}?screen=connect`)}`,
          // Exactly the one scope this tier needs, folded into what was granted before.
          scopes: GMAIL_PERMISSION_SCOPES.monitor ?? undefined,
          queryParams: INCREMENTAL_OAUTH_QUERY_PARAMS,
        },
      })
      if (err) {
        setError('Could not start Google sign-in. Try again.')
        setBusy(false)
      }
    } catch {
      setError('Could not start Google sign-in. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-10">
      <section className="space-y-4" aria-labelledby="connect-gmail">
        <h2 id="connect-gmail" className="r-section">
          Connect your mail
        </h2>
        <p className="r-body max-w-[56ch] text-r-ink-2">{GMAIL_LINE}</p>
        {connected ? (
          <p className="r-body">Gmail is connected.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Key onClick={connectGmail} disabled={busy}>
              {busy ? 'Opening Google' : 'Connect Gmail'}
            </Key>
          </div>
        )}
        {error && (
          <p role="alert" className="r-body">
            {error}
          </p>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="connect-model">
        <h2 id="connect-model" className="r-section">
          How Cello may think
        </h2>
        <p className="r-body max-w-[56ch] text-r-ink-2">
          Cello works with no model. A model lets it rank roles and check your chances.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Key asChild variant="raised">
            <Link href="/settings?tab=api-keys">Use a key I have</Link>
          </Key>
          <Key variant={modelChoice === 'none' ? 'ink' : 'raised'} aria-pressed={modelChoice === 'none'} onClick={() => setModelChoice('none')}>
            Not now. Cello works without one.
          </Key>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Key onClick={onDone}>Next</Key>
        {!connected && (
          <Key variant="ghost" onClick={onDone}>
            Not now
          </Key>
        )}
      </div>
    </div>
  )
}
