'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shape returned by GET /api/settings/status — the single source of truth
 * for "has this account uploaded a resume / saved an LLM key yet".
 */
export interface AccountStatus {
  hasResume: boolean
  /** "Can this account run an LLM feature right now" — provider-aligned (see keyProvider/llmKeyMessage). */
  hasKey: boolean
  canRunLlm?: boolean
  /** Which provider key actually grants LLM capability, or null if none does — an openai/anthropic-only
   *  key shows up in `keys` below but does NOT make this non-null, since it doesn't enable anything. */
  keyProvider?: 'openrouter' | null
  /** Actionable copy distinguishing "no key at all" from "wrong provider's key saved". Null when hasKey is true. */
  llmKeyMessage?: string | null
  keys?: {
    openrouter: boolean
    openai: boolean
    anthropic: boolean
    hunter: boolean
  }
  model?: string | null
  targetingConfigured?: boolean
}

interface UseAccountStatusResult {
  status: AccountStatus | null
  loading: boolean
  /** Human-readable message when the fetch (plus one retry) still failed. Null once resolved successfully. */
  error: string | null
  /** Re-run the fetch (fresh retry budget). Wire this to a "Retry" affordance — never swallow a failure silently. */
  refetch: () => void
}

async function fetchStatusOnce(): Promise<AccountStatus> {
  const res = await fetch('/api/settings/status')
  if (!res.ok) {
    // Try to surface a real server message (route returns { error }) instead
    // of a bare status code where possible.
    const body = await res.json().catch(() => null)
    const message =
      (body && typeof body.error === 'string' && body.error) || `Status check failed (HTTP ${res.status})`
    throw new Error(message)
  }
  return (await res.json()) as AccountStatus
}

/**
 * Fetches /api/settings/status, retries once on failure, and NEVER swallows
 * a persistent failure — `error` is set and logged via console.error so a
 * flaky network blip doesn't silently freeze hasResume/hasApiKey at `false`
 * forever with no way for the user (or us) to know why.
 *
 * Shared by the jobs page and the dashboard so both surfaces agree on
 * account status and both get the same retry behavior.
 */
export function useAccountStatus(): UseAccountStatusResult {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Guards against a stale in-flight request overwriting state after a newer
  // refetch() has already started.
  const requestIdRef = useRef(0)

  const fetchStatus = useCallback(() => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        let result: AccountStatus
        try {
          result = await fetchStatusOnce()
        } catch (firstError) {
          console.error('[use-account-status] first attempt failed, retrying once:', firstError)
          result = await fetchStatusOnce()
        }
        if (requestIdRef.current !== requestId) return
        setStatus(result)
        setError(null)
      } catch (finalError) {
        if (requestIdRef.current !== requestId) return
        const message = finalError instanceof Error ? finalError.message : 'Failed to check account status'
        console.error('[use-account-status] failed after retry:', finalError)
        setError(message)
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  return { status, loading, error, refetch: fetchStatus }
}
