'use client'

import Link from 'next/link'
import { ExternalLink, RefreshCw, Star, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CompanyLogo, getCompanyLogoSrc } from '@/components/companies/company-logo'
import { formatShortDate, matchTone } from '@/lib/format'

export interface CompanySummary {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
  career_url: string
  is_dream_company: boolean
  created_at: string
  last_scraped_at: string | null
  jobs_count?: number
  /** Max `jobs.match_score` across this company's jobs. Null (not 0) when none of its jobs are scored yet. */
  best_match_score?: number | null
}

export interface CompanyRowProps {
  company: CompanySummary
  isRefreshing: boolean
  onToggleDream: (company: CompanySummary) => void
  onRefresh: (company: CompanySummary) => void
  onDelete: (company: CompanySummary) => void
}

/** One company as a list row: logo, name, meta line, quiet actions. */
export function CompanyRow({
  company,
  isRefreshing,
  onToggleDream,
  onRefresh,
  onDelete,
}: CompanyRowProps) {
  const meta: string[] = []
  if (company.domain) meta.push(company.domain)
  meta.push(`${company.jobs_count ?? 0} open roles`)
  meta.push(
    company.last_scraped_at
      ? `Checked ${formatShortDate(company.last_scraped_at)}`
      : 'Never checked'
  )

  // undefined (field not yet requested by some caller) collapses to the same
  // "unscored" badge as an explicit null — only a real number counts as scored.
  const bestScore =
    typeof company.best_match_score === 'number' ? company.best_match_score : null
  const scoreTone = matchTone(bestScore)

  return (
    <div className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-sunken/60">
      <Link
        href={`/companies/${company.id}`}
        className="flex min-w-0 flex-1 items-center gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-control"
      >
        <CompanyLogo
          src={getCompanyLogoSrc(company.logo_url, company.domain, company.career_url)}
          name={company.name}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {/* title: this is the one place the full name survives — junk
                like a pasted "Can you change this to..." prefix pushes the
                real name past the truncate cutoff, so hover is the only way
                to read it without opening the row. */}
            <span className="truncate text-body font-medium text-foreground" title={company.name}>
              {company.name}
            </span>
            {company.is_dream_company && (
              <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
            )}
            <Badge tone={scoreTone} className="shrink-0 tabular-nums">
              {bestScore === null ? 'Not scored' : `${bestScore}% match`}
            </Badge>
          </div>
          <p className="truncate text-caption text-muted-foreground">{meta.join(' · ')}</p>
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onToggleDream(company)}
          title={
            company.is_dream_company ? 'Remove from dream companies' : 'Mark as dream company'
          }
          aria-label={
            company.is_dream_company
              ? `Remove ${company.name} from dream companies`
              : `Mark ${company.name} as a dream company`
          }
          aria-pressed={company.is_dream_company}
        >
          <Star
            className={
              company.is_dream_company
                ? 'h-4 w-4 fill-amber-400 text-amber-400'
                : 'h-4 w-4 text-muted-foreground'
            }
            aria-hidden
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRefresh(company)}
          disabled={isRefreshing}
          title="Refresh jobs"
          aria-label={isRefreshing ? `Refreshing jobs for ${company.name}` : `Refresh jobs for ${company.name}`}
        >
          <RefreshCw
            className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`}
            aria-hidden
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => window.open(company.career_url, '_blank')}
          title="Open careers page"
          aria-label={`Open careers page for ${company.name}`}
        >
          <ExternalLink className="h-4 w-4 text-muted-foreground" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(company)}
          title="Delete company"
          aria-label={`Delete ${company.name}`}
        >
          <Trash2 className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-red-500" aria-hidden />
        </Button>
      </div>
    </div>
  )
}
