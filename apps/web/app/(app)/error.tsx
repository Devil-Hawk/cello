'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * Route-segment error boundary for everything under the authenticated shell.
 * Next.js mounts this inside layout.tsx's `{children}` slot, not around the
 * layout itself, so a throw in any page here still leaves the sidebar and
 * header standing — only the content area falls back to this. Before this
 * file existed there was no error.tsx anywhere in the app (a design review
 * confirmed it: `find app -name error.tsx` returned nothing), so a render
 * throw on any page took out the whole shell — nav, route, everything.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // error.digest (surfaced below) is the only thing that ties this to a
    // production log entry — the full error only ever reaches the console.
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 py-12">
      <EmptyState
        icon={AlertTriangle}
        headingLevel="h1"
        title="This page hit an error"
        body="Nothing you did caused this — something broke while rendering. Retrying usually clears it."
        className="max-w-md"
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={() => reset()}>Try again</Button>
            <Button variant="outline" asChild>
              <Link href="/dashboard">Back to Today</Link>
            </Button>
          </div>
        }
      />
      {/* Technical detail stays secondary and muted, never the headline —
          error.message can be an ugly stack-trace fragment, and error.digest
          only matters to whoever is reading production logs. */}
      {(error.message || error.digest) && (
        <div className="w-full max-w-md space-y-0.5 rounded-control bg-sunken px-3 py-2 text-center">
          {error.message && (
            <p className="truncate text-caption text-muted-foreground" title={error.message}>
              {error.message}
            </p>
          )}
          {error.digest && (
            <p className="text-caption text-muted-foreground">
              Reference: <span className="font-readout">{error.digest}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
