'use client'

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { AccessibleFigure } from '@/components/charts/accessible-figure'
import { StackedMeter, type StackedMeterSegment } from '@/components/charts/stacked-meter'
import { TRUST_TIER_COLOR, TRUST_TIER_LABEL, type TrustTier } from '@/components/charts/tokens'

interface ProvenanceExample {
  jobUrl: string | null
  companyName: string | null
  reasons: string[]
}

interface ProvenanceSummaryResponse {
  ok: true
  breakdown: {
    total: number
    byTrustTier: Record<TrustTier, number>
  }
  examples: Partial<
    Record<'employer_official_board' | 'employer_via_aggregator' | 'aggregator_as_employer' | 'unverifiable', ProvenanceExample>
  >
}

const TIER_ORDER: TrustTier[] = ['official', 'secondhand', 'unverified']

/** Which example(s) (keyed by the finer-grained employerClass the API returns)
 *  best represent a coarse trust tier, in preference order. */
const TIER_EXAMPLE_KEYS: Record<TrustTier, (keyof ProvenanceSummaryResponse['examples'])[]> = {
  official: ['employer_official_board'],
  secondhand: ['aggregator_as_employer', 'employer_via_aggregator'],
  unverified: ['unverifiable'],
}

export function ProvenanceMixCard() {
  const [data, setData] = useState<ProvenanceSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // Distinct from "no jobs tracked" — a failed/slow fetch must never render as
  // a false "you have nothing here" claim when the corpus genuinely has jobs
  // (this route walks the whole jobs table server-side and can time out under
  // load; that's a fetch failure, not evidence of an empty account).
  const [loadError, setLoadError] = useState(false)
  const [activeTier, setActiveTier] = useState<TrustTier | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(false)
    fetch('/api/jobs/provenance?summary=1')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch(() => {
        setData(null)
        setLoadError(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (loadError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Where jobs really come from</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={ShieldCheck}
            title="Couldn't load provenance"
            body="This walks the full jobs table server-side and can time out under load — it doesn't mean there's no data. Try again."
            action={
              <Button variant="outline" onClick={load}>
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    )
  }

  if (!data || data.breakdown.total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Where jobs really come from</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={ShieldCheck}
            title="No jobs tracked yet"
            body="Provenance — the employer's own board vs. an aggregator vs. unverifiable — shows up here once discovery runs."
          />
        </CardContent>
      </Card>
    )
  }

  const { total, byTrustTier } = data.breakdown
  const segments: StackedMeterSegment[] = TIER_ORDER.map((tier) => ({
    key: tier,
    label: TRUST_TIER_LABEL[tier],
    count: byTrustTier[tier] ?? 0,
    color: TRUST_TIER_COLOR[tier],
  }))

  const example = activeTier
    ? TIER_EXAMPLE_KEYS[activeTier].map((k) => data.examples[k]).find((e) => !!e) ?? null
    : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where jobs really come from</CardTitle>
        <CardDescription>
          Provenance, computed per job by lib/sources/provenance.ts — the employer&apos;s own board vs. relayed
          through an aggregator vs. unverifiable. Click a segment for a real example.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessibleFigure
          interactive
          caption={`${total.toLocaleString()} tracked jobs by provenance tier.`}
          table={{
            columns: [
              { key: 'tier', label: 'Tier' },
              { key: 'count', label: 'Jobs', align: 'right' },
              { key: 'share', label: 'Share', align: 'right' },
            ],
            rows: segments.map((s) => [
              s.label,
              s.count.toLocaleString(),
              total === 0 ? '0%' : `${Math.round((s.count / total) * 100)}%`,
            ]),
          }}
        >
          <StackedMeter
            segments={segments}
            activeKey={activeTier}
            onSegmentClick={(key) => setActiveTier(activeTier === key ? null : (key as TrustTier))}
          />
        </AccessibleFigure>

        {activeTier && (
          <div className="rounded-control border bg-sunken/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-caption font-medium text-foreground">
                Example: {TRUST_TIER_LABEL[activeTier]}
                {example?.companyName ? ` — ${example.companyName}` : ''}
              </span>
              <button
                type="button"
                onClick={() => setActiveTier(null)}
                className="rounded-control text-caption text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            {example ? (
              <>
                <ul className="space-y-1">
                  {example.reasons.map((r, i) => (
                    <li key={i} className="text-caption text-muted-foreground">
                      &bull; {r}
                    </li>
                  ))}
                </ul>
                {example.jobUrl && (
                  <a
                    href={example.jobUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-caption font-medium text-accent-deep hover:underline"
                  >
                    View posting <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </>
            ) : (
              <p className="text-caption text-muted-foreground">No example available for this tier.</p>
            )}
          </div>
        )}

        <p className="text-caption text-muted-foreground">
          Full per-job breakdown lives in{' '}
          <Link href="/jobs" className="font-medium text-accent-deep hover:underline">
            Jobs
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  )
}
