'use client'

import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { RoleRow } from '@/components/roles/role-row'
import { companies } from '@/lib/routes'
import type { WelcomeRole } from '@/lib/welcome/commands.stub'
import { FOLLOW_LINE, LISTED_LINE, NO_FITS } from './logic'

function posted(iso: string | null): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'Posted today'
  if (days === 1) return 'Posted yesterday'
  return `Posted ${days} days ago`
}

// Screen 4: the roles that fit, in code order. Nothing is ranked yet, and the
// screen says so. `roles` is null while unread or when it could not be read.
export function YourRolesScreen({
  roles,
  loading,
  finishing,
  error,
  onBack,
  onFinish,
}: {
  roles: WelcomeRole[] | null
  loading: boolean
  finishing: boolean
  error: string | null
  onBack: () => void
  onFinish: () => void
}) {
  return (
    <div className="space-y-6">
      <h2 className="r-section">Your roles</h2>

      {loading && <p className="r-body text-r-ink-2">Reading roles for your search.</p>}

      {!loading && roles === null && (
        <p role="alert" className="r-body">
          Could not load roles. You can look again on Today.
        </p>
      )}

      {!loading && roles && roles.length === 0 && (
        <div className="space-y-4">
          <p className="r-body">{NO_FITS}</p>
          <div className="flex flex-wrap gap-3">
            <Key variant="raised" onClick={onBack}>
              Edit what you want
            </Key>
            <Key asChild variant="raised">
              <Link href={companies.href}>Follow an employer</Link>
            </Key>
          </div>
        </div>
      )}

      {!loading && roles && roles.length > 0 && (
        <div className="space-y-3">
          <p className="r-meta">{LISTED_LINE}</p>
          <div className="r-sheet">
            {roles.map((r) => (
              <RoleRow
                key={r.id}
                id={r.id}
                title={r.title}
                company={r.company}
                companyId={r.companyId}
                domain={r.domain}
                logoUrl={r.logoUrl}
                meta={[r.location, posted(r.postedAt)].filter(Boolean).join(' · ')}
              />
            ))}
          </div>
        </div>
      )}

      <p className="r-body text-r-ink-2">{FOLLOW_LINE}</p>
      {error && (
        <p role="alert" className="r-body">
          {error}
        </p>
      )}
      <Key onClick={onFinish} disabled={finishing}>
        {finishing ? 'Finishing' : 'Go to Today'}
      </Key>
    </div>
  )
}
