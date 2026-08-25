'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, Copy, Download, Loader2, Target } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from '@/components/ui/use-toast'
import { matchTone } from '@/lib/format'
import { cn } from '@/lib/utils'

interface AtsScore {
  atsScore: number
  missingKeywords: string[]
  matchedKeywords: string[]
  formatIssues: string[]
}

interface OptimizerResult extends AtsScore {
  suggestedRewrite: string
  rescore: AtsScore
}

const SCORE_TEXT: Record<string, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  muted: 'text-muted-foreground',
  bad: 'text-red-600 dark:text-red-400',
  none: 'text-muted-foreground',
}

function ScoreDial({ score, label }: { score: number; label: string }) {
  const tone = matchTone(score)
  return (
    <div className="text-center">
      <div className={cn('font-display text-stat tabular-nums', SCORE_TEXT[tone])}>{score}</div>
      <div className="text-label uppercase text-muted-foreground">{label}</div>
    </div>
  )
}

/**
 * ATS resume optimizer for a single job. Scores the resume, lists missing
 * keywords + format issues, and offers an honesty-constrained rewrite. The
 * rewrite never fabricates — that rule is enforced server-side in the
 * resume_optimizer module.
 */
export function ResumeOptimizerPanel({
  jobId,
  hasResume,
  hasApiKey,
  apiKeyMessage,
  statusError,
  onRetryStatus,
}: {
  jobId: string
  hasResume: boolean
  /** LLM key present — the optimizer runs three model passes and needs one. */
  hasApiKey?: boolean
  /**
   * Precise copy from /api/settings/status distinguishing "no key at all"
   * from "an openai/anthropic key is saved but the harness only runs
   * OpenRouter" — falls back to a generic message when not provided.
   */
  apiKeyMessage?: string | null
  /** Set when the account-status check itself failed — distinct from "missing resume/key". */
  statusError?: string | null
  /** Wired to retry the account-status fetch when statusError is set. */
  onRetryStatus?: () => void
}) {
  const [result, setResult] = useState<OptimizerResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showRewrite, setShowRewrite] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Honest progress while the three serial model passes (score, rewrite,
  // rescore) run — this can take the better part of a minute.
  useEffect(() => {
    if (!loading) {
      setElapsedMs(0)
      return
    }
    const start = Date.now()
    const id = setInterval(() => setElapsedMs(Date.now() - start), 250)
    return () => clearInterval(id)
  }, [loading])

  const disabledReason: string | null = statusError
    ? "Couldn't check your account status — retry"
    : !hasResume
      ? 'Upload a resume in Settings'
      : hasApiKey === false
        ? (apiKeyMessage ?? 'Add an API key in Settings')
        : null

  async function optimize() {
    if (disabledReason) {
      setError(disabledReason)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/resume/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      })
      // Read as text first: a platform-level timeout or gateway error can
      // return an HTML body instead of JSON, and res.json() throwing into a
      // bare catch used to collapse every failure into one generic message.
      const rawText = await res.text()
      let data: { result?: OptimizerResult; error?: string } | null = null
      try {
        data = rawText ? JSON.parse(rawText) : null
      } catch (parseErr) {
        console.error('[resume-optimizer] non-JSON response', {
          status: res.status,
          body: rawText.slice(0, 500),
        })
        setError(
          res.status === 504
            ? 'The optimizer timed out (it runs three model passes back to back) — try again.'
            : `Optimizer returned an unexpected response (HTTP ${res.status}).`
        )
        return
      }

      if (!res.ok || !data?.result) {
        const message = data?.error ?? `Optimization failed (HTTP ${res.status})`
        console.error('[resume-optimizer] request failed', { status: res.status, error: data?.error })
        setError(message)
      } else {
        setResult(data.result)
      }
    } catch (err) {
      console.error('[resume-optimizer] network error', err)
      setError(err instanceof Error ? `Failed to run the optimizer: ${err.message}` : 'Failed to run the optimizer')
    } finally {
      setLoading(false)
    }
  }

  async function acceptRewrite() {
    if (!result) return
    // navigator.clipboard is undefined on plain http origins — fall back to
    // the always-visible textarea + download below instead of a dead end.
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(result.suggestedRewrite)
        setCopied(true)
        toast({ title: 'Rewrite copied', description: 'Paste it into your resume doc to apply.' })
        setTimeout(() => setCopied(false), 2000)
        return
      } catch (err) {
        console.error('[resume-optimizer] clipboard write failed', err)
      }
    }
    toast({
      title: 'Clipboard unavailable',
      description: 'Select the text below (or download it) to copy manually.',
      variant: 'destructive',
    })
  }

  function downloadRewrite() {
    if (!result) return
    const blob = new Blob([result.suggestedRewrite], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'resume-rewrite.txt'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const delta = result ? result.rescore.atsScore - result.atsScore : 0
  const isBlocked = !!disabledReason
  const elapsedSeconds = Math.floor(elapsedMs / 1000)

  const runButton = (
    <Button
      size="sm"
      variant={result ? 'outline' : 'default'}
      onClick={() => {
        if (!isBlocked && !loading) optimize()
      }}
      // aria-disabled, not the native attribute: a truly disabled button
      // stops receiving hover/focus, which would make the reason tooltip
      // below unreachable — the control must stay inspectable, not vanish.
      aria-disabled={isBlocked || loading}
      className={cn(isBlocked && 'cursor-not-allowed opacity-60')}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {loading ? 'Scoring…' : result ? 'Re-run ATS check' : 'Run ATS check'}
    </Button>
  )

  return (
    <div className="rounded-card border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-body font-medium text-foreground">
          <Target className="h-4 w-4 text-muted-foreground" />
          Optimize resume for this role
        </h3>
        {isBlocked ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>{runButton}</TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs p-3">
                <div className="space-y-2">
                  <p className="text-caption">{disabledReason}</p>
                  {statusError && onRetryStatus ? (
                    <Button size="sm" variant="outline" onClick={onRetryStatus}>
                      Retry
                    </Button>
                  ) : (
                    <Link href="/settings" className="text-caption font-medium text-accent-deep hover:underline">
                      Go to Settings
                    </Link>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          runButton
        )}
      </div>

      {error && <p className="text-caption text-red-600 dark:text-red-400">{error}</p>}

      {loading && (
        <p className="text-caption text-muted-foreground">
          This runs three model passes (score, rewrite, rescore) and can take a minute
          {elapsedSeconds > 0 ? ` — ${elapsedSeconds}s elapsed` : ''}.
        </p>
      )}

      {!result && !error && !loading && (
        <p className="text-caption text-muted-foreground">
          Score your resume against this job for ATS keyword and format fit (0–100), see what&apos;s
          missing, and get a rewrite that only surfaces content you already have.
        </p>
      )}

      {result && (
        <div className="space-y-4">
          {/* Score before/after */}
          <div className="flex items-center justify-center gap-6 rounded-control bg-sunken/60 py-3">
            <ScoreDial score={result.atsScore} label="Current" />
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <ScoreDial score={result.rescore.atsScore} label="After rewrite" />
            {delta !== 0 && (
              <Badge tone={delta > 0 ? 'good' : 'bad'}>
                {delta > 0 ? '+' : ''}
                {delta}
              </Badge>
            )}
          </div>

          {/* Missing keywords */}
          {result.missingKeywords.length > 0 && (
            <div>
              <div className="mb-1.5 text-label uppercase text-muted-foreground">Missing keywords</div>
              <div className="flex flex-wrap gap-1.5">
                {result.missingKeywords.map((k) => (
                  <span
                    key={k}
                    className="rounded-full bg-amber-100 px-2 py-0.5 text-caption text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Matched keywords */}
          {result.matchedKeywords.length > 0 && (
            <div>
              <div className="mb-1.5 text-label uppercase text-muted-foreground">Already covered</div>
              <div className="flex flex-wrap gap-1.5">
                {result.matchedKeywords.slice(0, 12).map((k) => (
                  <span
                    key={k}
                    className="rounded-full bg-emerald-100 px-2 py-0.5 text-caption text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Format issues */}
          {result.formatIssues.length > 0 && (
            <div>
              <div className="mb-1.5 text-label uppercase text-muted-foreground">Format fixes</div>
              <ul className="space-y-1 text-caption text-muted-foreground">
                {result.formatIssues.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span>•</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Suggested rewrite */}
          <div>
            <button
              onClick={() => setShowRewrite((s) => !s)}
              className="text-caption font-medium text-accent-deep hover:underline"
            >
              {showRewrite ? 'Hide' : 'Show'} suggested rewrite
            </button>
            {showRewrite && (
              <div className="mt-2 space-y-2">
                <textarea
                  readOnly
                  value={result.suggestedRewrite}
                  onFocus={(e) => e.currentTarget.select()}
                  rows={10}
                  aria-label="Suggested resume rewrite — click to select all, then copy"
                  className="w-full resize-y rounded-control border bg-sunken/60 p-3 font-sans text-caption text-foreground"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={acceptRewrite}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy to clipboard'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={downloadRewrite}>
                    <Download className="h-3.5 w-3.5" />
                    Download as .txt
                  </Button>
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Clipboard access needs a secure (https) origin. If copy doesn&apos;t work, click into the
                  box above (it auto-selects) and copy manually, or download the file.
                </p>
              </div>
            )}
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            Rewrites only reorganize and rephrase your real experience — they never invent
            employers, titles, dates, or skills.
          </p>
        </div>
      )}
    </div>
  )
}
