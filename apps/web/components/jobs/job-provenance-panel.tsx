'use client'

// Wires GET /api/jobs/provenance onto the job detail surface
// (docs/PRODUCT-VISION.md #5 / "PROVENANCE ON EVERY OPPORTUNITY"): where a
// posting came from, whether it's the employer's own board or an aggregator
// (or the aggregator masquerading AS the employer — the specific failure mode
// the vision doc calls out), whether the description is complete, and whether
// automatic application is supported. Every bullet in `reasons` is computed
// server-side by lib/sources/provenance.ts — this component renders that
// honest, plain-language output verbatim rather than re-deriving copy.

import { useCallback, useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Globe, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

type EmployerClass =
  | 'employer_official_board'
  | 'employer_via_aggregator'
  | 'aggregator_as_employer'
  | 'unverifiable'

interface JobProvenance {
  jobId: string
  source: { id: string | null; label: string; kind: string }
  employerClass: EmployerClass
  descriptionComplete: boolean
  autoApplySupported: boolean
  verification: { lastVerifiedAt: string | null; stillOpen: boolean | null; basis: string }
  confidence: number
  reasons: string[]
}

const CLASS_CONFIG: Record<EmployerClass, { tone: BadgeTone; label: string; Icon: LucideIcon }> = {
  employer_official_board: { tone: 'good', label: "Employer's own board", Icon: ShieldCheck },
  employer_via_aggregator: { tone: 'warn', label: 'Found via an aggregator', Icon: ShieldQuestion },
  aggregator_as_employer: { tone: 'bad', label: 'Aggregator, not a real employer match', Icon: ShieldX },
  unverifiable: { tone: 'neutral', label: 'Source unverified', Icon: ShieldQuestion },
}

export function JobProvenancePanel({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobProvenance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/jobs/provenance?jobId=${encodeURIComponent(jobId)}`)
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.provenance) {
        throw new Error(json?.error ?? `Failed to load provenance (HTTP ${res.status})`)
      }
      setData(json.provenance as JobProvenance)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load provenance')
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 text-caption text-red-600 dark:text-red-400">
        <span>{error}</span>
        <Button size="sm" variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    )
  }

  if (!data) return null

  const cfg = CLASS_CONFIG[data.employerClass]
  const Icon = cfg.Icon
  // A job discovered via lib/search/job-discovery.ts's web_search rung must
  // never render identically to one Cello's own board-watch pipeline pulled
  // directly (docs/PRODUCT-VISION.md #5) — even when the trust badge above
  // legitimately reads "Employer's own board" because the hit was verified
  // against the real ATS API. This badge is keyed on source.id, independent
  // of employerClass/trustTier, so it always shows regardless of how the
  // search hit was ultimately classified.
  const foundViaWebSearch = data.source.id === 'web_search'

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={cfg.tone}>
          <Icon className="h-3 w-3" />
          {cfg.label}
        </Badge>
        {foundViaWebSearch && (
          <Badge tone="accent">
            <Globe className="h-3 w-3" />
            Found via web search
          </Badge>
        )}
        <Badge tone={data.descriptionComplete ? 'good' : 'warn'}>
          {data.descriptionComplete ? 'Description complete' : 'Description missing or short'}
        </Badge>
        <Badge tone={data.autoApplySupported ? 'good' : 'neutral'}>
          {data.autoApplySupported ? 'Auto-apply supported' : 'Manual apply only'}
        </Badge>
      </div>
      <ul className="space-y-1 text-caption text-muted-foreground">
        {data.reasons.map((r, i) => (
          <li key={i} className="flex items-start gap-2">
            <span aria-hidden>•</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
