'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Briefcase, Building2, ExternalLink, Globe } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { StatRow } from '@/components/ui/stat-row'
import { CompanyLogo, getCompanyLogoSrc } from '@/components/companies/company-logo'
import { formatShortDate, knownParts } from '@/lib/format'
import { getRoleType } from '@/lib/jobs/role-types'
import type { CompanyPage, RoleHit } from '@/lib/companies'

// One employer. It only reads: GET /api/companies/<id> and GET /api/companies/<id>/roles?q=.

const typeLabel = (id: string | null) => (id ? (getRoleType(id)?.label ?? id) : 'Other')

export default function CompanyPageView() {
  const { id } = useParams<{ id: string }>()
  const [company, setCompany] = useState<CompanyPage | null>(null)
  const [roles, setRoles] = useState<RoleHit[]>([])
  const [q, setQ] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/companies/${id}`)
      .then((res) => (res.ok ? (res.json() as Promise<CompanyPage>) : null))
      .then(setCompany)
      .catch(() => setCompany(null))
      .finally(() => setIsLoading(false))
  }, [id])

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
        title="Company not found"
        headingLevel="h1"
        body="Cello does not have that employer, or the link is wrong."
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
        </div>
      </Card>

      <StatRow
        stats={[
          { label: 'Open roles', value: company.openCount ?? (unreadable ? 'Cannot read' : company.closed ? 'Closed' : 'Not read yet') },
          { label: 'Last checked', value: company.checked ? formatShortDate(company.checked.at) : 'Not yet' },
        ]}
      />
      {note && <p className="text-body text-muted-foreground">{note}</p>}

      {company.openCount !== null && company.byType.length > 0 && (
        <p className="text-body text-muted-foreground">
          {company.openCount} open: {company.byType.map((t) => `${t.open} ${typeLabel(t.roleType).toLowerCase()}`).join(', ')}.
        </p>
      )}
      <p className="text-body text-muted-foreground">Cello has not matched these to your targets yet.</p>

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
