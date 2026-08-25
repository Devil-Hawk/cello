'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ScoreBand } from '@/lib/jobs/score-bands'

export interface InsightsSummary {
  totalJobs: number
  scoreHistogram: Record<ScoreBand, number>
  bySource: Record<string, { total: number; scored: number }>
}

export interface UseInsightsSummaryResult {
  summary: InsightsSummary | null
  loading: boolean
  /** True on a failed/timed-out fetch — distinct from "loaded, zero jobs" so
   *  neither card built on top of this hook (score histogram, source
   *  performance) ever renders a false "you have no data" empty state for
   *  what is actually a fetch failure. GET /api/jobs/insights-summary walks
   *  the whole jobs table server-side and can be slow under load. */
  error: boolean
  retry: () => void
}

/**
 * Single fetch of GET /api/jobs/insights-summary, shared by
 * ScoreHistogramCard and SourcePerformanceCard (app/(app)/insights/page.tsx
 * calls this once and passes the result to both) — the route does a real
 * full-table aggregate scan, so two independent components each fetching it
 * would double an already-expensive read for no benefit.
 */
export function useInsightsSummary(): UseInsightsSummaryResult {
  const [summary, setSummary] = useState<InsightsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    fetch('/api/jobs/insights-summary')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => setSummary(data))
      .catch(() => {
        setSummary(null)
        setError(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return { summary, loading, error, retry: load }
}
