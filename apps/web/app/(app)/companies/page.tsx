'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Building2, FileWarning, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { StatRow } from '@/components/ui/stat-row'
import { CompanyLogo, getCompanyLogoSrc } from '@/components/companies/company-logo'
import { formatShortDate } from '@/lib/format'
import type { CompaniesPage, CompanyRow } from '@/lib/companies'

// The wall of employers. It only reads: GET /api/companies, and the add field posts a pasted link to /api/companies/add.

const PAGE = 50

/** What the tile says. A count only after a read; "Cannot read" with the reason in the tooltip; never a 0 that is not known. */
function line(row: CompanyRow): string {
  if (row.closed) return 'Closed'
  if (row.checked && !row.checked.ok) return 'Cannot read'
  return row.openCount === null ? 'Not read yet' : `${row.openCount} open`
}

function Row({ row }: { row: CompanyRow }) {
  const tip = row.checked ? `${row.checked.ok ? 'Checked' : 'Could not read'} ${formatShortDate(row.checked.at)}` : undefined
  return (
    <Link href={`/companies/${row.employerId}`} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-sunken/60">
      <CompanyLogo src={getCompanyLogoSrc(row.logoUrl, row.domain, '')} name={row.name} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-foreground">{row.name}</span>
        <p className="truncate text-caption text-muted-foreground" title={tip}>
          {[row.domain, row.hq, line(row)].filter(Boolean).join(' · ')}
        </p>
      </div>
      {row.following && <Badge tone="accent">Following</Badge>}
    </Link>
  )
}

export default function CompaniesPageView() {
  const [page, setPage] = useState<CompaniesPage | null>(null)
  const [rows, setRows] = useState<CompanyRow[]>([])
  const [more, setMore] = useState(false)
  const [matched, setMatched] = useState<number | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(
    async (offset: number) => {
      setIsLoading(true)
      setLoadError(null)
      try {
        const res = await fetch(`/api/companies?limit=${PAGE}&offset=${offset}${showClosed ? '&show_closed=1' : ''}`)
        if (!res.ok) throw new Error('load')
        const data = (await res.json()) as CompaniesPage
        setPage(data)
        setMatched((m) => data.matched ?? m)
        setRows((prev) => (offset === 0 ? data.rows : [...prev, ...data.rows]))
        setMore(data.rows.length === PAGE)
      } catch {
        setLoadError("Couldn't load the companies. Check your connection and try again.")
      } finally {
        setIsLoading(false)
      }
    },
    [showClosed]
  )

  useEffect(() => {
    load(0)
  }, [load])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!link.trim() || adding) return
    setAdding(true)
    setMessage(null)
    try {
      const res = await fetch('/api/companies/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link: link.trim() }) })
      const result = await res.json()
      setMessage(result.ok ? `Following ${result.employer.name}.` : (result.line ?? result.error ?? 'Could not add that employer right now.'))
      if (result.ok) {
        setLink('')
        await load(0)
      }
    } catch {
      setMessage('Could not add that employer right now.')
    } finally {
      setAdding(false)
    }
  }

  const following = rows.filter((r) => r.following)
  const others = rows.filter((r) => !r.following)
  const header = page?.header

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-title text-foreground">Companies</h1>
        {header?.backgroundOff && <p className="mt-1 text-body text-muted-foreground">Background work is off on this server.</p>}
        {header?.paced && <p className="mt-1 text-body text-muted-foreground">Cello is pacing its checks to stay within the free allowance.</p>}
        {header?.checked.missedText && <p className="mt-1 text-body text-muted-foreground">{header.checked.missedText}</p>}
      </div>

      {header && (
        <StatRow
          stats={[
            { label: 'Found by Cello this week', value: header.foundByCelloThisWeek },
            { label: 'You follow', value: header.following },
            { label: 'Last checked', value: header.checked.lastSucceededAt ? formatShortDate(header.checked.lastSucceededAt) : 'Not yet' },
            { label: 'Employers checked', value: header.seedProgress.verified },
          ]}
        />
      )}

      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
        <Input type="text" aria-label="Paste an employer's careers link" placeholder="Paste a careers link" value={link} onChange={(e) => setLink(e.target.value)} />
        <Button type="submit" disabled={adding || !link.trim()}>
          <Plus className="h-4 w-4" />
          {adding ? 'Checking' : 'Add company'}
        </Button>
      </form>
      {message && (
        <p className="text-caption text-muted-foreground" role="status">
          {message}
        </p>
      )}

      {isLoading && rows.length === 0 ? (
        <Card className="divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3.5">
              <Skeleton className="h-10 w-10 rounded-control" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
            </div>
          ))}
        </Card>
      ) : loadError ? (
        <EmptyState icon={FileWarning} title="Couldn't load the companies" body={loadError} action={<Button onClick={() => load(0)}>Retry</Button>} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Building2} title="No companies yet" body="Paste an employer's careers link, and Cello will read its open roles." />
      ) : (
        <>
          {matched !== null && <p className="text-caption text-muted-foreground">{matched === 1 ? '1 employer matches' : `${matched.toLocaleString('en-US')} employers match`}</p>}
          {following.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-display text-section text-foreground">Following</h2>
              <Card className="divide-y">{following.map((r) => <Row key={r.employerId} row={r} />)}</Card>
            </section>
          )}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-section text-foreground">Everyone else</h2>
              <label className="flex items-center gap-2 text-caption text-muted-foreground">
                <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
                Show closed
              </label>
            </div>
            <Card className="divide-y">{others.map((r) => <Row key={r.employerId} row={r} />)}</Card>
          </section>
          {more && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={isLoading} onClick={() => load(rows.length)}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
