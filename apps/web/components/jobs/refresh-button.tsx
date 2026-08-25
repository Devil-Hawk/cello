'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'

interface RefreshResult {
  ok: boolean
  results: Array<{
    companyId: string
    companyName: string
    provider: 'greenhouse' | 'lever' | 'ashby' | null
    found: number
    inserted: number
    errors: string[]
  }>
  totals: { found: number; inserted: number; companiesWithAts: number }
}

interface RefreshJobsButtonProps {
  /** Refresh a single company; omit to refresh all of the user's companies. */
  companyId?: string
  /** Called after a successful refresh so the parent can refetch. */
  onRefreshed?: () => void
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  className?: string
}

/** Prominent "Refresh jobs" action wired to POST /api/jobs/refresh. */
export function RefreshJobsButton({
  companyId,
  onRefreshed,
  variant = 'default',
  size = 'default',
  className,
}: RefreshJobsButtonProps) {
  const [isRefreshing, setIsRefreshing] = useState(false)

  async function refresh() {
    setIsRefreshing(true)
    try {
      const response = await fetch('/api/jobs/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(companyId ? { companyId } : {}),
      })

      const data: RefreshResult | null = await response.json().catch(() => null)

      if (!response.ok || !data?.ok) {
        const message =
          (data as { error?: string } | null)?.error ||
          `Refresh failed (${response.status})`
        throw new Error(message)
      }

      const { totals } = data
      toast({
        title: 'Jobs refreshed',
        description: `${totals.inserted} new · ${totals.found} found · ${totals.companiesWithAts} ${
          totals.companiesWithAts === 1 ? 'company' : 'companies'
        } with an ATS board`,
      })
      onRefreshed?.()
    } catch (error) {
      toast({
        title: 'Refresh failed',
        description:
          error instanceof Error ? error.message : 'Could not refresh jobs. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <Button
      onClick={refresh}
      disabled={isRefreshing}
      variant={variant}
      size={size}
      className={className}
    >
      {isRefreshing ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          Refreshing…
        </>
      ) : (
        <>
          <RefreshCw className="h-4 w-4" />
          Refresh jobs
        </>
      )}
    </Button>
  )
}
