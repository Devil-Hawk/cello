'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Briefcase, Building2, ExternalLink, Globe, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { StatRow } from '@/components/ui/stat-row'
import { CompanyLogo, getCompanyLogoSrc } from '@/components/companies/company-logo'
import { DossierPanel } from '@/components/companies/dossier-panel'
import { ContactNetworkPanel } from '@/components/contacts/contact-network-panel'
import { formatShortDate, knownParts } from '@/lib/format'
import { getRoleType } from '@/lib/jobs/role-types'
import type { CompanyPage, RoleHit } from '@/lib/companies'

// One employer. It only reads: GET /api/companies/<id> and GET /api/companies/<id>/roles?q=.

// Sentence case: "ML Engineer" reads "ML engineer" (acronyms stay), and "7 ML engineer" mid-sentence.
const typeWords = (id: string | null) =>
  (id ? (getRoleType(id)?.label ?? id) : 'Other')
    .split(' ')
    .map((w) => (w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ')
const typeLabel = (id: string | null) => typeWords(id).replace(/^./, (c) => c.toUpperCase())

export default function CompanyPageView() {
  const { id } = useParams<{ id: string }>()
  const [company, setCompany] = useState<CompanyPage | null>(null)
  const [failure, setFailure] = useState<'missing' | 'error' | null>(null)
  const [roles, setRoles] = useState<RoleHit[]>([])
  const [q, setQ] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [checkLine, setCheckLine] = useState<string | null>(null)

  const load = useCallback(() => {
    return fetch(`/api/companies/${id}`)
      .then((res) => {
        setFailure(res.ok ? null : res.status === 404 ? 'missing' : 'error')
        return res.ok ? (res.json() as Promise<CompanyPage>) : null
      })
      .then(setCompany)
      .catch(() => (setFailure('error'), setCompany(null)))
      .finally(() => setIsLoading(false))
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  // "Check now": the same one reader the schedule uses, for this employer, through the existing trigger route.
  async function checkNow(followId: string) {
    setChecking(true)
    setCheckLine(null)
    try {
      const res = await fetch('/api/scraper/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: followId }) })
      const data = await res.json()
      setCheckLine(data.message ?? data.error ?? 'Cello could not check this employer right now.')
      if (data.success) await load()
    } catch {
      setCheckLine('Cello could not check this employer right now.')
    } finally {
      setChecking(false)
    }
  }

  // Search inside the employer runs on the server, 250 ms after the last key.
  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/companies/${id}/roles?q=${encodeURIComponent(q.trim())}`)
        .then((res) => (res.ok ? res.json() : { roles: [] }))
        .then((d: { roles: RoleHit[] }) => setRoles(d.roles))
        .catch(() => setRoles([]))
    }, 250)
    return () => clearTimeout(t)
  }, [id, q])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="sr-only">Company, loading</h1>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-48 w-full rounded-card" />
      </div>
    )
  }

  if (!company) {
    return (
      <EmptyState
        icon={Building2}
        title={failure === 'error' ? "Couldn't load this company" : 'Company not found'}
        headingLevel="h1"
        body={failure === 'error' ? 'Cello could not load this company right now.' : 'Cello does not have that employer, or the link is wrong.'}
        action={
          <Button variant="outline" asChild>
            <Link href="/companies">
              <ArrowLeft className="h-4 w-4" />
              Back to companies
            </Link>
          </Button>
        }
      />
    )
  }

  const unreadable = company.checked && !company.checked.ok && !company.closed
  const note = company.closed
    ? 'This board has left the rotation.'
    : unreadable
      ? `Cello could not read ${company.domain ?? company.name}${company.checked?.line ? `: ${company.checked.line}` : ''}.`
      : null

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/companies">
          <ArrowLeft className="h-4 w-4" />
          Back to companies
        </Link>
      </Button>

      <Card className="p-5">
        <div className="flex min-w-0 items-center gap-4">
          <CompanyLogo src={getCompanyLogoSrc(company.logoUrl, company.domain, company.careersUrl ?? '')} name={company.name} className="h-16 w-16" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-title text-foreground">{company.name}</h1>
              {company.following && <Badge tone="accent">Following</Badge>}
            </div>
            <p className="mt-1 text-caption text-muted-foreground">{company.hq}</p>
            {company.domain && (
              <a href={`https://${company.domain}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-caption text-muted-foreground transition-colors hover:text-foreground">
                <Globe className="h-3.5 w-3.5" />
                {company.domain}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {company.followId && (
            <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => checkNow(company.followId!)} disabled={checking}>
              <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
              Check now
            </Button>
          )}
        </div>
      </Card>
      {checkLine && (
        <p className="text-body text-foreground" role="status">
          {checkLine}
        </p>
      )}

      <StatRow
        stats={[
          { label: 'Open roles', value: company.openCount ?? (unreadable ? 'Cannot read' : company.closed ? 'Closed' : 'Not read yet') },
          { label: 'Last checked', value: company.checked ? formatShortDate(company.checked.at) : 'Not yet' },
        ]}
      />
      {note && <p className="text-body text-muted-foreground">{note}</p>}

      {company.openCount !== null && company.byType.length > 0 && (
        <p className="text-body text-muted-foreground">
          {company.openCount} open: {company.byType.map((t) => `${t.open} ${typeWords(t.roleType)}`).join(', ')}.
        </p>
      )}
      <p className="text-body text-muted-foreground">Cello has not matched these to your targets yet.</p>

      {company.followId && (
        <>
          <DossierPanel companyId={company.followId} />
          <ContactNetworkPanel companyId={company.followId} variant="card" />
        </>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-section text-foreground">Open roles{company.checked?.ok && company.openCount !== null ? ` (${company.openCount})` : ''}</h2>
          <Input type="text" aria-label="Search this employer's roles" placeholder="Search titles, types and descriptions" value={q} onChange={(e) => setQ(e.target.value)} className="sm:max-w-xs" />
        </div>
        {roles.length === 0 ? (
          <EmptyState icon={Briefcase} title={q.trim() ? 'No roles match' : 'No roles stored yet'} body={q.trim() ? 'Try another word.' : 'Cello stores a role when it is inside someone\'s targets.'} />
        ) : (
          <Card className="divide-y">
            {roles.map((role) => (
              <div key={role.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-foreground">{role.title}</span>
                  <p className="mt-0.5 truncate text-caption text-muted-foreground">
                    {knownParts(role.roleType ? typeLabel(role.roleType) : null, role.location, role.postedAt ? `Posted ${formatShortDate(role.postedAt)}` : null, role.chance).join(' · ')}
                  </p>
                </div>
                {role.kept && <Badge tone="accent">Kept</Badge>}
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => window.open(role.url, '_blank')}>
                  <ExternalLink className="h-4 w-4" />
                  View
                </Button>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  )
}
