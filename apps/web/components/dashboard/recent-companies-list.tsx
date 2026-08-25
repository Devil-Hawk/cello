'use client'

import Link from 'next/link'
import { Building2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AnimatedList } from '@/components/ui/motion'
import { formatShortDate } from '@/lib/format'

export interface RecentCompany {
  id: string
  name: string
  logo_url: string | null
  domain: string | null
  career_url: string
  created_at: string
}

function getLogoUrl(company: RecentCompany): string | null {
  if (company.logo_url) return company.logo_url

  let domain = company.domain
  if (!domain) {
    try {
      const url = new URL(company.career_url)
      domain = url.hostname.replace(/^www\./, '')
    } catch {
      return null
    }
  }

  // Convert job domains to main domain (amazon.jobs → amazon.com)
  const logoDomain = domain.replace(/\.(jobs|careers)$/, '.com').replace(/^(jobs|careers)\./, '')
  return `https://www.google.com/s2/favicons?domain=${logoDomain}&sz=128`
}

interface RecentCompaniesListProps {
  companies: RecentCompany[]
}

/** Compact list of the most recently added companies. */
export function RecentCompaniesList({ companies }: RecentCompaniesListProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Recent companies</CardTitle>
        {companies.length > 0 && (
          <Link
            href="/companies"
            className="text-caption font-medium text-accent-deep hover:underline"
          >
            View all
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {companies.length === 0 ? (
          <div className="py-6 text-center">
            <p className="mb-4 text-caption text-muted-foreground">No companies tracked yet.</p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/companies">
                <Plus className="h-4 w-4" />
                Add company
              </Link>
            </Button>
          </div>
        ) : (
          <AnimatedList
            items={companies}
            keyExtractor={(company) => company.id}
            className="divide-y"
            renderItem={(company) => {
              const logoUrl = getLogoUrl(company)
              return (
                <Link
                  href={`/companies/${company.id}`}
                  className="group flex items-center gap-3 py-2.5 transition-colors first:pt-0 last:pb-0"
                >
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-control border bg-white object-contain p-1"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement
                        target.style.display = 'none'
                        target.nextElementSibling?.classList.remove('hidden')
                      }}
                    />
                  ) : null}
                  <div
                    className={`h-9 w-9 shrink-0 items-center justify-center rounded-control bg-sunken ${
                      logoUrl ? 'hidden' : 'flex'
                    }`}
                  >
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-foreground group-hover:text-accent-deep">
                      {company.name}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      Added {formatShortDate(company.created_at)}
                    </p>
                  </div>
                </Link>
              )
            }}
          />
        )}
      </CardContent>
    </Card>
  )
}
