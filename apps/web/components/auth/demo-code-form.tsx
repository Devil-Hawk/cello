'use client'

// The demo-code path on the login page.
//
// Deliberately SECONDARY. Almost everyone arriving here is a real user signing
// into their own account; the code path is for the one person who was handed a
// code for a demo. So it stays collapsed behind a single line of text until
// someone asks for it, rather than competing with sign-in for attention.
//
// The code is typed by a human, usually after being read off a message or said
// out loud, so the input has to forgive everything that survives that trip:
// lowercase, spaces, missing or extra dashes. All of it is normalized on the
// server by normalizeAccessCode(); nothing here rewrites what someone typed.
// The uppercase look is CSS only — the value stays exactly as entered, so the
// caret never jumps mid-word, which is what auto-formatting a grouped code
// always ends up doing.

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * How many characters a code has once separators are stripped.
 *
 * Duplicated from lib/access/codes.ts on purpose: that module imports
 * node:crypto at the top level for hashing, and importing it here would drag
 * node:crypto into the browser bundle. This is only an affordance — it decides
 * whether the button is enabled, nothing more. The server re-checks the shape
 * with the real looksLikeAccessCode() before it touches anything.
 */
const CODE_LENGTH = 12

/** Same forgiving strip the server's normalizer applies, for the length check
 *  only. */
function strippedLength(input: string): number {
  return input.replace(/[^A-Za-z0-9]/g, '').length
}

export function DemoCodeForm() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  function reveal() {
    setOpen(true)
    // Next paint, once the input exists.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return

    setLoading(true)
    setError(null)

    try {
      // POST with a JSON body, never a query string: a code in a URL ends up in
      // browser history, referrers, and every access log between here and the
      // server.
      const response = await fetch('/api/access/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })

      const result = await response.json().catch(() => null)

      if (!response.ok || !result?.ok) {
        setError(result?.error ?? "That code isn't valid. Ask whoever shared it for a new one.")
        setLoading(false)
        return
      }

      // The session cookie is already set by the response. Clear the code from
      // component state on the way out so it does not sit in memory behind the
      // dashboard.
      setCode('')
      router.push(typeof result.redirect === 'string' ? result.redirect : '/dashboard')
      router.refresh()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <div className="text-center">
        <button
          type="button"
          onClick={reveal}
          className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-caption text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          aria-expanded={false}
          aria-controls="demo-code-panel"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          Have a demo code?
        </button>
      </div>
    )
  }

  return (
    <div id="demo-code-panel" className="space-y-3 border-t pt-5">
      <div className="space-y-1">
        <label
          htmlFor="demo-code"
          className="font-readout text-label uppercase tracking-[0.14em] text-muted-foreground"
        >
          Demo code
        </label>
        <p className="text-caption text-muted-foreground">
          Signs you into a demo workspace with its own data. Codes last 72 hours.
        </p>
      </div>

      <form onSubmit={redeem} className="space-y-3">
        <Input
          id="demo-code"
          ref={inputRef}
          name="demo-code"
          value={code}
          onChange={e => {
            setCode(e.target.value)
            if (error) setError(null)
          }}
          placeholder="P7QK-3M9X-TCR2"
          // Codes travel through chat apps and phone calls: never autofilled,
          // never autocorrected, never treated as a word.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={32}
          disabled={loading}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'demo-code-error' : undefined}
          className="h-10 uppercase tracking-[0.18em] placeholder:tracking-[0.18em] placeholder:text-muted-foreground/60"
        />

        {error && (
          <p id="demo-code-error" role="alert" className="text-center text-caption text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="outline"
          disabled={loading || strippedLength(code) !== CODE_LENGTH}
          className="h-10 w-full"
        >
          {loading ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Opening demo…
            </>
          ) : (
            'Enter demo'
          )}
        </Button>
      </form>
    </div>
  )
}
