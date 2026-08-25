'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Newspaper,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { VisaBadge } from '@/components/jobs/visa-badge'
import { formatShortDate } from '@/lib/format'
import type {
  CompanyDossierRow,
  CompIntel,
  MissingSummaryReason,
  SourceMatchReason,
} from '@/lib/dossier/store'

interface DossierPanelProps {
  companyId: string
}

const CONFIDENCE_TONE = { high: 'good', medium: 'warn', low: 'muted' } as const

/** Human-readable label for WHY a source qualified (SourceMatchReason). */
const MATCH_LABELS: Record<SourceMatchReason, string> = {
  domain: "links to the company's own site",
  'exact-title': 'title names the company',
  'official-site': 'official site',
  careers: 'careers page',
  wikipedia: 'verified Wikipedia match',
  github: 'GitHub org',
}

/**
 * Copy for every reason `summary` can be null — never a guess, always exactly
 * what the server reported (see MissingSummaryReason in lib/dossier/store.ts).
 * `body` says explicitly whether clicking Refresh would plausibly help.
 */
const MISSING_SUMMARY_COPY: Record<MissingSummaryReason, { title: string; body: (detail?: string) => string }> = {
  'no-key': {
    title: 'No AI summary yet',
    body: () =>
      'No OpenRouter API key is configured, so nothing has been synthesized. Add a key in Settings, then refresh.',
  },
  'no-signals': {
    title: 'Nothing substantial to summarize',
    body: () =>
      "Public signals were collected, but nothing was solid enough to reason about — no verified Wikipedia page, and the company's own site couldn't be read. Refresh may help if the site was only temporarily unreachable.",
  },
  'generation-failed': {
    title: 'AI summary failed',
    body: (detail) => `Generating the summary failed${detail ? ` (${detail})` : ''}. Refresh to try again.`,
  },
  stale: {
    title: 'AI summary not generated yet',
    body: () => 'This research predates your OpenRouter key. Refresh to generate an AI-written summary now.',
  },
}

function formatUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n / 1000)}k`
  return `$${n}`
}

function compRangeLabel(comp: CompIntel): string | null {
  if (comp.rangeLow == null) return null
  if (comp.rangeHigh == null) return `~${formatUsd(comp.rangeLow)}`
  return `${formatUsd(comp.rangeLow)} – ${formatUsd(comp.rangeHigh)}`
}

export function DossierPanel({ companyId }: DossierPanelProps) {
  const [dossier, setDossier] = useState<CompanyDossierRow | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/companies/${companyId}/dossier`)
      const data = await res.json()
      setDossier((data?.dossier as CompanyDossierRow | null) ?? null)
    } catch {
      /* leave dossier null; the generate button remains available */
    } finally {
      setIsLoading(false)
    }
  }, [companyId])

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    if (isGenerating) return
    setIsGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/companies/${companyId}/dossier`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Research failed')
      } else {
        setDossier((data?.dossier as CompanyDossierRow | null) ?? null)
      }
    } catch {
      setError('Research failed — please try again.')
    } finally {
      setIsGenerating(false)
    }
  }

  const comp = dossier?.comp_intel ?? null
  const compRange = comp ? compRangeLabel(comp) : null
  const signals = dossier?.signals ?? null
  const techStack = signals?.techStack ?? []
  const news = signals?.news ?? []
  const sources = dossier?.sources ?? []
  // Only meaningful when there's no summary — the server always sets this
  // alongside a null summary (see MissingSummaryReason), never left to guess.
  const missingSummary = !dossier?.summary ? (signals?.summaryUnavailable ?? null) : null

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            Company research
          </CardTitle>
          {dossier && (
            <p className="mt-1 text-caption text-muted-foreground">
              From public sources · refreshed {formatShortDate(dossier.refreshed_at)}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={generate} disabled={isGenerating || isLoading}>
          {isGenerating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : dossier ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {isGenerating ? 'Researching…' : dossier ? 'Refresh' : 'Research company'}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 border-l-2 border-red-400/60 bg-red-50/60 py-2 pl-3 text-body text-foreground dark:bg-red-500/5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <span>{error}</span>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : !dossier ? (
          <p className="text-body text-muted-foreground">
            Assemble a dossier from free public sources — the company&#39;s own site, Wikipedia, recent
            news, comp range, and a visa-sponsorship signal.
          </p>
        ) : (
          <>
            {/* Summary — the ACTUAL server-reported reason when there isn't one, never a guess */}
            {dossier.summary ? (
              <div>
                <p className="whitespace-pre-wrap text-body text-foreground">{dossier.summary}</p>
                {signals?.summarySource === 'wikipedia' && (
                  <p className="mt-1 text-caption text-muted-foreground">
                    From Wikipedia — not AI-synthesized. Refresh with an OpenRouter key configured for
                    real reasoning about this company.
                  </p>
                )}
              </div>
            ) : missingSummary ? (
              <div className="flex items-start gap-2 border-l-2 border-border py-2 pl-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-body font-medium text-foreground">
                    {MISSING_SUMMARY_COPY[missingSummary.reason].title}
                  </p>
                  <p className="mt-0.5 text-body text-muted-foreground">
                    {MISSING_SUMMARY_COPY[missingSummary.reason].body(missingSummary.detail)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-body text-muted-foreground">Public signals collected.</p>
            )}

            {/* Signal chips */}
            <div className="flex flex-wrap items-center gap-2">
              <VisaBadge signal={dossier.sponsors_visa} />
              {compRange && comp && (
                <Badge tone={CONFIDENCE_TONE[comp.confidence]} title={comp.source}>
                  Comp {compRange} · {comp.confidence}
                </Badge>
              )}
              {signals?.funding && <Badge tone="neutral">{signals.funding}</Badge>}
              {signals?.headcountTrend && <Badge tone="neutral">{signals.headcountTrend}</Badge>}
            </div>

            {/* Comp caveat */}
            {comp && (
              <p className="text-caption text-muted-foreground">
                Comp: {comp.source}. Always verify current sponsorship and pay with the employer.
              </p>
            )}

            {/* What they likely want from a candidate — AI reasoning, grounded in sources */}
            {signals?.whatTheyWant && (
              <div>
                <p className="text-caption font-medium text-foreground">What they likely want</p>
                <p className="mt-0.5 text-body text-muted-foreground">{signals.whatTheyWant}</p>
              </div>
            )}

            {/* Genuine uncertainty — say the quiet part instead of padding */}
            {signals?.uncertainty && (
              <div>
                <p className="text-caption font-medium text-foreground">Genuinely uncertain</p>
                <p className="mt-0.5 text-body text-muted-foreground">{signals.uncertainty}</p>
              </div>
            )}

            {/* Culture */}
            {signals?.culture && (
              <div>
                <p className="text-caption font-medium text-foreground">Culture</p>
                <p className="mt-0.5 text-body text-muted-foreground">{signals.culture}</p>
              </div>
            )}

            {/* Tech stack */}
            {techStack.length > 0 && (
              <div>
                <p className="text-caption font-medium text-foreground">Tech stack</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {techStack.map((t) => (
                    <Badge key={t} tone="neutral">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* News — every item shown here was VERIFIED to be about this company (matchedBy); an
                empty list means nothing verifiable was found, which is a correct, expected outcome. */}
            {news.length > 0 && (
              <div>
                <p className="flex items-center gap-1.5 text-caption font-medium text-foreground">
                  <Newspaper className="h-3.5 w-3.5" />
                  Recent mentions
                </p>
                <ul className="mt-1 space-y-1">
                  {news.slice(0, 5).map((n) => (
                    <li key={n.url} className="truncate text-caption">
                      <a
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={n.matchedBy ? MATCH_LABELS[n.matchedBy] : undefined}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {n.title}
                        {n.matchedBy && (
                          <span className="text-muted-foreground"> · {MATCH_LABELS[n.matchedBy]}</span>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Sources — each carries WHY it qualified (matchedBy) so a wrong item would be visibly
                attributable rather than anonymous. An empty list is a valid, expected outcome: it
                means nothing could be verified as actually about this company, not that the research
                failed. */}
            <div>
              <p className="text-caption font-medium text-foreground">Sources</p>
              {sources.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {sources.map((s) => (
                    <a
                      key={s.url}
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={s.matchedBy ? MATCH_LABELS[s.matchedBy] : undefined}
                      className="inline-flex items-center gap-1 text-caption text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {s.title}
                      {s.matchedBy && (
                        <span className="text-muted-foreground">· {MATCH_LABELS[s.matchedBy]}</span>
                      )}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-0.5 text-caption text-muted-foreground">
                  No public source could be verified as actually about this company.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
