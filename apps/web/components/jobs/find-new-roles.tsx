'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LogoMark } from '@/components/brand/logo'
import { Skeleton } from '@/components/ui/skeleton'
import type { FindNewRolesStatus } from '@/lib/ingest/status'
import { STATUS_ERROR_COPY, detailsLines, statusCopy } from '@/lib/ingest/status-copy'

const POLL_MS = 20_000

/**
 * The "Find new roles" line on the Jobs page: when Cello last checked the
 * companies the user watches, what came back, and which ones it could not read.
 * One line on a laptop, two under the heading on a phone. Never a spinner of
 * its own: while a check is running it shows the cello scroll drawing.
 */
export function FindNewRoles({ className = '' }: { className?: string }) {
  const [status, setStatus] = useState<FindNewRolesStatus | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function load() {
      try {
        const res = await fetch('/api/ingestion/status', { cache: 'no-store' })
        if (!res.ok) throw new Error('status')
        const data = (await res.json()) as FindNewRolesStatus
        if (cancelled) return
        setStatus(data)
        setError(false)
        // A check in progress is worth watching; a finished one is not.
        if (data.state === 'checking') timer = setTimeout(load, POLL_MS)
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const root = `relative basis-full text-sm text-muted-foreground sm:basis-auto tabular-nums ${className}`

  if (error) {
    return (
      <p className={root} role="status">
        {STATUS_ERROR_COPY}
      </p>
    )
  }
  if (!status) {
    return (
      <div className={root} aria-hidden="true">
        <Skeleton className="h-3.5 w-40 sm:w-60" />
      </div>
    )
  }

  const now = new Date()
  const copy = statusCopy(status, now)
  const details = copy.details ? detailsLines(status, Math.max(status.failed.length, status.companiesTotal - status.companiesChecked)) : null
  const noCompanies = status.state === 'never' && !status.hasCompanies

  return (
    <div className={root} role="status">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="flex items-center gap-1.5">
          {copy.working && <LogoMark className="h-4 w-4 shrink-0" loading />}
          {copy.tone === 'danger' && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-destructive" />}
          {!noCompanies && <span className="font-semibold text-foreground">Find new roles</span>}
          <span className={copy.details ? 'text-foreground' : undefined}>
            {noCompanies ? (
              <>
                Find new roles checks your companies every 6 hours.{' '}
                <Link href="/companies" className="font-medium text-brand underline-offset-4 hover:underline">
                  Add a company
                </Link>{' '}
                to start.
              </>
            ) : (
              <>
                <span className="hidden sm:inline">{copy.long}</span>
                <span className="sm:hidden">{copy.short}</span>
              </>
            )}
          </span>
        </span>
        {(copy.next || details) && (
          <span className="flex items-center gap-3">
            {copy.next && <span>{copy.next}</span>}
            {details && (
              <details className="group">
                <summary className="cursor-pointer list-none rounded-sm font-medium text-brand marker:hidden hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                  Details
                </summary>
                <div className="absolute left-0 right-0 top-full z-10 mt-2 rounded-lg border border-border bg-background p-3 text-sm text-foreground sm:left-auto sm:w-[28rem]">
                  <ul className="space-y-1">
                    {details.items.map((line) => (
                      <li key={line} className="break-words">
                        {line}
                      </li>
                    ))}
                  </ul>
                  {details.more && <p className="mt-1 text-muted-foreground">{details.more}</p>}
                  <p className="mt-2 border-t border-border pt-2 text-muted-foreground">{details.footer}</p>
                </div>
              </details>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
