'use client'

import { Shell } from '@/components/layout/shell'
import { RoleRow } from '@/components/roles/role-row'
import { Key } from '@/components/ui/key'
import { fixtureRows } from '../_data'

// The shell around 25 role rows, made up. ?at=/companies/abc marks another page current.
export default function ShellFixture({ searchParams }: { searchParams: { at?: string; needs?: string } }) {
  const rows = fixtureRows(25)
  const needs = searchParams.needs ? Number(searchParams.needs) : undefined
  return (
    <Shell
      pathname={searchParams.at ?? '/jobs'}
      user={{ email: 'sam@example.com', fullName: 'Sam Rivera', avatarUrl: null }}
      onSignOut={() => undefined}
      needsYou={needs}
      bell={false}
    >
      <div className="mx-auto max-w-[1200px]">
        <h1 className="r-display">Roles</h1>
        <div className="r-sheet mt-8">
          {rows.map((r) => (
            <RoleRow
              key={r.id}
              id={r.id}
              title={r.title}
              company={r.company.name}
              companyId={r.id}
              domain={null}
              meta={`${r.place} · ${r.posted}`}
              actions={
                <>
                  <Key>Interested</Key>
                  <Key variant="raised">Not for me</Key>
                </>
              }
            />
          ))}
        </div>
      </div>
    </Shell>
  )
}
