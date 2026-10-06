'use client'

// Every saved version of your resume, named by role, company and the day it was sent: Open it,
// Compare it, or Delete it. A version an application sent, and the current base, say why they stay.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/utils'
import { compareWith, deleteRefusal, versionLabel, type VersionRow } from './versions'

/** Rows shown before "Show all". */
export const VERSIONS_SHOWN = 25

export interface VersionsGroupProps {
  versions: VersionRow[]
  currentBaseId: string | null
  onOpen: (version: VersionRow, compare: VersionRow | null) => void
  /** Deletes a version. Returns what went wrong, or null. */
  onDelete: (version: VersionRow) => Promise<string | null>
}

function Row({ v, all, currentBaseId, onOpen, onDelete }: { v: VersionRow; all: VersionRow[] } & Omit<VersionsGroupProps, 'versions'>) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refusal = deleteRefusal(v, currentBaseId)
  const other = compareWith(v, all)
  const label = versionLabel(v)

  async function remove() {
    setBusy(true)
    const problem = await onDelete(v)
    setBusy(false)
    if (problem) setError(problem)
  }

  return (
    <li className="py-3">
      <p className="break-words text-body font-medium text-foreground">{label}</p>
      <p className="text-caption text-muted-foreground">
        Version {v.version}, {v.source === 'tailored' ? 'tailored' : v.source === 'edited' ? 'edited by you' : 'base'}, {formatRelativeTime(v.created_at)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Button type="button" variant="ghost" className="min-h-11" aria-label={`Open ${label}`} onClick={() => onOpen(v, null)}>
          Open
        </Button>
        {other && (
          <Button type="button" variant="ghost" className="min-h-11" aria-label={`Compare ${label}`} onClick={() => onOpen(v, other)}>
            Compare
          </Button>
        )}
        {refusal ? (
          <p className="max-w-md text-caption text-muted-foreground">{refusal}</p>
        ) : confirming ? (
          <>
            <span className="text-caption text-muted-foreground">Delete this version? It cannot be undone.</span>
            <Button type="button" variant="destructive" className="min-h-11" disabled={busy} onClick={remove}>
              Delete
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" className="min-h-11" aria-label={`Delete ${label}`} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}

export function VersionsGroup({ versions, currentBaseId, onOpen, onDelete }: VersionsGroupProps) {
  const [all, setAll] = useState(false)
  const shown = all ? versions : versions.slice(0, VERSIONS_SHOWN)
  return (
    <div>
      <ul className="divide-y">
        {shown.map((v) => (
          <Row key={v.id} v={v} all={versions} currentBaseId={currentBaseId} onOpen={onOpen} onDelete={onDelete} />
        ))}
      </ul>
      {versions.length > shown.length && (
        <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={() => setAll(true)}>
          Show all {versions.length} versions
        </Button>
      )}
    </div>
  )
}
