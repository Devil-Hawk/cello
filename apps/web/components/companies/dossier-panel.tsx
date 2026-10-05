'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Newspaper,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { VisaBadge } from '@/components/jobs/visa-badge'
import { formatShortDate } from '@/lib/format'
import { dossierView, type ShownStatement } from '@/lib/dossier/present'
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
    title: 'No research written yet',
    body: () => 'No model key is set. Add an OpenRouter key in Settings, then refresh.',
  },
  'no-signals': {
    title: 'Nothing substantial to summarize',
    body: () =>
      "No readable page or verified Wikipedia match turned up for this company. Refresh in a few minutes in case the site was down, or check the company's domain.",
  },
  'generation-failed': {
    title: 'The research could not be written',
    body: (detail) => `The model's answer could not be used${detail ? ` (${detail})` : ''}. Refresh to try again.`,
  },
  stale: {
    title: 'Research not written yet',
    body: () => 'This research was collected before a model key was set. Refresh to write it now.',
  },
}

/** Small numbered links after a statement, one per source it cites. */
function Marks({ marks, urls }: { marks: number[]; urls: Map<number, string> }) {
  return (
    <>
      {marks.map((n) => (
        <a
          key={n}
          href={urls.get(n)}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-0.5 align-super text-[10px] font-medium text-accent-deep hover:underline"
          aria-label={`Source ${n}`}
        >
          [{n}]
        </a>
      ))}
    </>
  )
}

function Statement({ st, urls }: { st: ShownStatement; urls: Map<number, string> }) {
  return (
    <>
      {st.text}
      <Marks marks={st.marks} urls={urls} />
    </>
  )
}

function formatUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n / 1000)}k`
  return `$${n}`
}

function compRangeLabel(comp: CompIntel): string | null {
  if (comp.rangeLow == null) return null
  if (comp.rangeHigh == null) return `~${formatUsd(comp.rangeLow)}`
  return `${formatUsd(comp.rangeLow)} to ${formatUsd(comp.rangeHigh)}`
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
      setError('Research failed. Try again.')
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
  const view = dossierView(signals)
  const urls = new Map(view.cited.map((c) => [c.n, c.url]))
  const wikipediaLegacy = signals?.summarySource === 'wikipedia'

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
            <Search className="h-4 w-4" />
          )}
          {isGenerating ? 'Researching' : dossier ? 'Refresh' : 'Research company'}
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
            Research pulls the company&#39;s own site, Wikipedia and recent news, and links every statement to
            where it came from.
          </p>
        ) : (
          <>
            {/* Summary — the ACTUAL server-reported reason when there isn't one, never a guess */}
            {dossier.summary ? (
              <div>
                {view.hasCitations ? (
                  <p className="text-body text-foreground">
                    {view.summary.map((st, k) => (
                      <span key={k}>
                        {k > 0 && ' '}
                        <Statement st={st} urls={urls} />
                      </span>
                    ))}
                  </p>
                ) : (
                  <p className="whitespace-pre-wrap text-body text-foreground">{dossier.summary}</p>
                )}
                {wikipediaLegacy ? (
                  <p className="mt-1 text-caption text-muted-foreground">
                    From Wikipedia, not research. Refresh to research this company.
                  </p>
                ) : !view.hasCitations ? (
                  <p className="mt-1 text-caption text-muted-foreground">
                    Written before statements were linked to their sources. Refresh to add the links.
                  </p>
                ) : null}
                {view.evidenceLine && <p className="mt-1 text-caption text-muted-foreground">{view.evidenceLine}</p>}
                {view.wikipediaOnly && (
                  <p className="mt-1 text-caption font-medium text-foreground">
                    Only Wikipedia had anything on this company. Treat this as background, not research.
                  </p>
                )}
                {view.dropped > 0 && (
                  <p className="mt-1 text-caption text-muted-foreground">
                    {view.dropped} {view.dropped === 1 ? 'statement was' : 'statements were'} left out because no source backed{' '}
                    {view.dropped === 1 ? 'it' : 'them'}.
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
                <p className="mt-0.5 text-body text-muted-foreground">
                  {view.field('whatTheyWant') ? <Statement st={view.field('whatTheyWant')!} urls={urls} /> : signals.whatTheyWant}
                </p>
              </div>
            )}

            {/* Genuine uncertainty — say the quiet part instead of padding */}
            {signals?.uncertainty && (
              <div>
                <p className="text-caption font-medium text-foreground">Not certain</p>
                <p className="mt-0.5 text-body text-muted-foreground">{signals.uncertainty}</p>
              </div>
            )}

            {/* Culture */}
            {signals?.culture && (
              <div>
                <p className="text-caption font-medium text-foreground">Culture</p>
                <p className="mt-0.5 text-body text-muted-foreground">
                  {view.field('culture') ? <Statement st={view.field('culture')!} urls={urls} /> : signals.culture}
                </p>
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

            {/* Sources. New research numbers the sources its statements cite; older
                research lists the sources it collected, each with why it qualified. */}
            <div>
              <p className="text-caption font-medium text-foreground">Sources</p>
              {view.cited.length > 0 ? (
                <>
                  <ol className="mt-1 space-y-1">
                    {view.cited.map((c) => (
                      <li key={c.n} className="flex gap-1.5 text-caption text-muted-foreground">
                        <span className="w-4 shrink-0 font-medium text-foreground">{c.n}.</span>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground"
                        >
                          <span className="truncate">{c.title}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      </li>
                    ))}
                  </ol>
                  {view.other.length > 0 && (
                    <p className="mt-1.5 text-caption text-muted-foreground">
                      Also read:{' '}
                      {view.other.map((o, k) => (
                        <span key={o.url}>
                          {k > 0 && ', '}
                          <a href={o.url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
                            {o.title}
                          </a>
                        </span>
                      ))}
                    </p>
                  )}
                </>
              ) : sources.length > 0 ? (
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
                      {s.matchedBy && <span className="text-muted-foreground">· {MATCH_LABELS[s.matchedBy]}</span>}
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
