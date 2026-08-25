'use client'

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { JOB_FUNCTIONS, SENIORITY_LEVELS, type JobFunction, type Seniority } from '@/lib/jobs/classify'

// Hour-granularity freshness, filtered/sorted on `posted_at` (never
// `discovered_at`, which is one timestamp per ingest batch and makes every
// job in a batch look equally fresh regardless of when it was actually
// posted). 1,348 rows have a NULL posted_at — those are excluded from every
// bucket below unless "include undated" is on.
export type Freshness = '1h' | '3h' | '7h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d'
export type FreshnessValue = Freshness | 'all'

/** Bucket width in hours. */
export const FRESHNESS_HOURS: Record<Freshness, number> = {
  '1h': 1,
  '3h': 3,
  '7h': 7,
  '12h': 12,
  '24h': 24,
  '3d': 3 * 24,
  '7d': 7 * 24,
  '14d': 14 * 24,
  '30d': 30 * 24,
}

export function isFreshness(value: string | null): value is Freshness {
  return value !== null && value in FRESHNESS_HOURS
}

const FRESHNESS_OPTIONS: Array<{ value: FreshnessValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '1h', label: '1h' },
  { value: '3h', label: '3h' },
  { value: '7h', label: '7h' },
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
  { value: '3d', label: '3d' },
  { value: '7d', label: '7d' },
  { value: '14d', label: '14d' },
  { value: '30d', label: '30d' },
]

export type FunctionFacet = JobFunction | 'all'
export type SeniorityFacet = Seniority | 'all'
export type LanguageFacet = 'en' | 'de' | 'fr' | 'es' | 'nl' | 'unknown' | 'all'

export const LANGUAGE_OPTIONS: Array<{ value: LanguageFacet; label: string }> = [
  { value: 'all', label: 'Any language' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'unknown', label: 'Unknown' },
]

function labelize(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

interface FacetChipsProps {
  freshness: FreshnessValue
  onFreshnessChange: (value: FreshnessValue) => void
  includeUndated: boolean
  onIncludeUndatedChange: (value: boolean) => void
  companies: Array<{ id: string; name: string }>
  /** 'all' or a company id. */
  selectedCompany: string
  onCompanyChange: (companyId: string) => void
  locationQuery: string
  onLocationQueryChange: (query: string) => void
  jobFunction: FunctionFacet
  onJobFunctionChange: (value: FunctionFacet) => void
  seniority: SeniorityFacet
  onSeniorityChange: (value: SeniorityFacet) => void
  remoteOnly: boolean
  onRemoteOnlyChange: (value: boolean) => void
  country: string
  onCountryChange: (value: string) => void
  language: LanguageFacet
  onLanguageChange: (value: LanguageFacet) => void
  hideLowQuality: boolean
  onHideLowQualityChange: (value: boolean) => void
  shown: number
  total: number
}

/** Facet row: freshness segmented control, classification facets, company pills, live count. */
export function FacetChips({
  freshness,
  onFreshnessChange,
  includeUndated,
  onIncludeUndatedChange,
  companies,
  selectedCompany,
  onCompanyChange,
  locationQuery,
  onLocationQueryChange,
  jobFunction,
  onJobFunctionChange,
  seniority,
  onSeniorityChange,
  remoteOnly,
  onRemoteOnlyChange,
  country,
  onCountryChange,
  language,
  onLanguageChange,
  hideLowQuality,
  onHideLowQualityChange,
  shown,
  total,
}: FacetChipsProps) {
  return (
    <div className="space-y-3 rounded-card border bg-card p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          aria-label="Freshness"
          options={FRESHNESS_OPTIONS}
          value={freshness}
          onValueChange={onFreshnessChange}
        />
        <FacetCheckbox
          label="Include undated"
          checked={includeUndated}
          onChange={onIncludeUndatedChange}
          title="Also show jobs with no posted date (shown as 'Discovered …')"
        />
        <span className="ml-auto font-readout text-caption tabular-nums text-muted-foreground">
          {shown} / {total}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Input
          value={locationQuery}
          onChange={(e) => onLocationQueryChange(e.target.value)}
          placeholder="Location contains…"
          className="h-8 w-40"
          aria-label="Filter by location"
        />

        <Select value={jobFunction} onValueChange={(v) => onJobFunctionChange(v as FunctionFacet)}>
          <SelectTrigger className="h-8 w-36" aria-label="Filter by job function">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any function</SelectItem>
            {JOB_FUNCTIONS.map((fn) => (
              <SelectItem key={fn} value={fn}>
                {labelize(fn)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={seniority} onValueChange={(v) => onSeniorityChange(v as SeniorityFacet)}>
          <SelectTrigger className="h-8 w-36" aria-label="Filter by seniority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any seniority</SelectItem>
            {SENIORITY_LEVELS.map((s) => (
              <SelectItem key={s} value={s}>
                {labelize(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={language} onValueChange={(v) => onLanguageChange(v as LanguageFacet)}>
          <SelectTrigger className="h-8 w-32" aria-label="Filter by language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={country}
          onChange={(e) => onCountryChange(e.target.value.toUpperCase().slice(0, 2))}
          placeholder="Country (e.g. US)"
          className="h-8 w-32"
          aria-label="Filter by country code"
        />

        <FacetCheckbox label="Remote only" checked={remoteOnly} onChange={onRemoteOnlyChange} />

        <FacetCheckbox
          label="Hide low-quality"
          checked={hideLowQuality}
          onChange={onHideLowQualityChange}
          title="Hide postings the classifier flags as junk (synthesized titles, nav links, bare city/department names)"
        />
      </div>

      {companies.length > 1 && (
        <CompanyFilter
          companies={companies}
          selected={selectedCompany}
          onChange={onCompanyChange}
        />
      )}
    </div>
  )
}

function FacetCheckbox({
  label,
  checked,
  onChange,
  title,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  title?: string
}) {
  return (
    <label
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control px-2.5 text-caption font-medium transition-colors',
        checked
          ? 'bg-accent-soft text-accent-deep'
          : 'bg-sunken/60 text-muted-foreground hover:text-foreground'
      )}
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded-sm border-input accent-primary"
      />
      {label}
    </label>
  )
}

/**
 * Company filter.
 *
 * This used to render every tracked company as a pill — with 200+ companies that
 * buried the actual job list under a wall of chips. Now it's a search box that
 * only reveals matches, plus pills for the handful you've pinned as dream
 * companies (the ones worth one-click access).
 */
function CompanyFilter({
  companies,
  selected,
  onChange,
}: {
  companies: Array<{ id: string; name: string }>
  selected: string
  onChange: (value: string) => void
}) {
  const [query, setQuery] = useState('')
  const selectedCompany = companies.find((c) => c.id === selected) ?? null

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return companies.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [companies, query])

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${companies.length} companies…`}
            className="h-8"
            aria-label="Search companies"
          />
          {matches.length > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-control border bg-card shadow-pop">
              {matches.map((company) => (
                <button
                  key={company.id}
                  type="button"
                  onClick={() => {
                    onChange(company.id)
                    setQuery('')
                  }}
                  className="block w-full truncate px-3 py-2 text-left text-caption text-foreground hover:bg-muted"
                >
                  {company.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedCompany ? (
          <CompanyPill
            label={selectedCompany.name}
            active
            onClick={() => onChange('all')}
          />
        ) : (
          <span className="text-caption text-muted-foreground">All companies</span>
        )}
      </div>
    </div>
  )
}

function CompanyPill({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? `Remove ${label} filter` : label}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {label}
      {active && <span aria-hidden>✕</span>}
    </button>
  )
}
