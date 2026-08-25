'use client'

// Wires the previously-unreachable contact sourcing + outreach draft engines
// onto a job or company surface (docs/PRODUCT-VISION.md items #2/#3/#4):
//   - "Find contacts"  -> POST /api/contacts/source (lib/contacts/sources.ts)
//   - "Draft outreach" -> POST /api/outreach/draft (approve-queue guardrails
//     stay fully intact — this only ever creates a pending_review row; sending
//     stays a human action from the Queue page)
//   - "Possible warm paths" -> contacts already on file at this company with a
//     personal `relationship` set (colleague/alumni/friend/...) are the exact
//     signal lib/harness/agents/enricher.ts computes for its insiderConnections
//     field, read directly here instead of through the harness. The
//     buildWarmIntroPlan chain (lib/harness/chains.ts) was deliberately NOT
//     wired to a button here: its own module comment documents that
//     follow_upper (the chain's last step) only scans STUCK applications more
//     than 10 days old and ignores its fanned-out `contact` input entirely —
//     for a job with no application yet (the warm-intro case) it reliably
//     returns "No active applications to follow up on" and drafts nothing, so
//     a button that ran the full multi-agent chain would burn a 300s budget
//     to produce no outreach. This panel gets the user the same information
//     (who they already know here) instantly and for free, then reuses the
//     already-correct /api/outreach/draft endpoint to act on it.
//
// Two render shells share one data/loading/error core: `variant="card"` (the
// company page — a standalone Card) and `variant="plain"` (the job detail
// modal, which is itself a Dialog surface — no Card-in-a-surface here).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mail, Sparkles, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { ContactProvenanceBadge } from './provenance-badge'
import { isPersonalRelationship, RELATIONSHIP_LABELS } from './types'

interface NetworkContact {
  id: string
  name: string
  email: string | null
  title: string | null
  relationship: string | null
  source?: string | null
  confidence?: number | null
  verified?: boolean | null
  basis?: string | null
}

function SourceButton({ sourcing, onClick }: { sourcing: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={sourcing}>
      {sourcing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      {sourcing ? 'Finding…' : 'Find contacts'}
    </Button>
  )
}

export function ContactNetworkPanel({
  companyId,
  jobId,
  variant = 'card',
}: {
  companyId: string
  /** When present, sourcing/drafting is scoped to this specific role — used both for personalization and as the outreach dedupe key. */
  jobId?: string
  variant?: 'card' | 'plain'
}) {
  const [contacts, setContacts] = useState<NetworkContact[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sourcing, setSourcing] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  const [draftingId, setDraftingId] = useState<string | null>(null)
  const [draftedIds, setDraftedIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/contacts?companyId=${encodeURIComponent(companyId)}&limit=50`)
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.error ?? `Failed to load contacts (HTTP ${res.status})`)
      setContacts((data.contacts ?? []) as NetworkContact[])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load contacts')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => {
    load()
  }, [load])

  async function sourceContacts() {
    setSourcing(true)
    setSourceError(null)
    setSourceNote(null)
    try {
      const res = await fetch('/api/contacts/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, jobId }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.error ?? `Contact sourcing failed (HTTP ${res.status})`)
      const insertedCount = Array.isArray(data.inserted) ? data.inserted.length : 0
      setSourceNote(
        insertedCount > 0
          ? `Found ${insertedCount} new contact${insertedCount === 1 ? '' : 's'} from public sources.`
          : 'No new contacts found — nothing usable in the job posting or company research yet.'
      )
      await load()
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : 'Contact sourcing failed')
    } finally {
      setSourcing(false)
    }
  }

  async function draftOutreach(contact: NetworkContact) {
    setDraftingId(contact.id)
    try {
      const res = await fetch('/api/outreach/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact.id, jobId }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.error ?? `Failed to draft outreach (HTTP ${res.status})`)
      setDraftedIds((prev) => new Set(prev).add(contact.id))
      toast({
        title: 'Draft ready for review',
        description: `An intro email to ${contact.name} is waiting in your queue — nothing sends until you approve it.`,
      })
    } catch (e) {
      toast({
        title: 'Could not draft outreach',
        description: e instanceof Error ? e.message : 'Something went wrong.',
        variant: 'destructive',
      })
    } finally {
      setDraftingId(null)
    }
  }

  const warmContacts = (contacts ?? []).filter((c) => isPersonalRelationship(c.relationship))
  const otherContacts = (contacts ?? []).filter((c) => !isPersonalRelationship(c.relationship))
  const ordered = [...warmContacts, ...otherContacts]

  const body = (
    <div className="space-y-3">
      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-control border border-red-400/40 bg-red-50/60 px-3 py-2 text-caption text-foreground dark:bg-red-500/5">
          <span>{loadError}</span>
          <Button size="sm" variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : ordered.length === 0 ? (
        !loadError && (
          <p className="text-caption text-muted-foreground">
            No contacts on file at this company yet. Source some from public data, or add one on the{' '}
            <Link href="/contacts" className="font-medium text-accent-deep hover:underline">
              Contacts page
            </Link>
            .
          </p>
        )
      ) : (
        <>
          {warmContacts.length > 0 && (
            <Panel tone="accent" divider="none" className="rounded-control">
              <p className="text-caption font-medium text-foreground">
                Possible warm path{warmContacts.length === 1 ? '' : 's'}
              </p>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {warmContacts
                  .map(
                    (c) =>
                      `${c.name}${c.relationship ? ` (${RELATIONSHIP_LABELS[c.relationship] ?? c.relationship})` : ''}`
                  )
                  .join(', ')}{' '}
                — already in your network at this company.
              </p>
            </Panel>
          )}

          <ul className="divide-y">
            {ordered.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-body font-medium text-foreground">{c.name}</span>
                    {isPersonalRelationship(c.relationship) && (
                      <Badge tone="neutral">
                        {RELATIONSHIP_LABELS[c.relationship as string] ?? c.relationship}
                      </Badge>
                    )}
                    <ContactProvenanceBadge contact={c} />
                  </div>
                  <p className="truncate text-caption text-muted-foreground">
                    {[c.title, c.email].filter(Boolean).join(' · ') || 'No title or email on file'}
                  </p>
                </div>
                {c.email && (
                  <Button size="sm" variant="outline" disabled={draftingId === c.id} onClick={() => draftOutreach(c)}>
                    {draftingId === c.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Mail className="h-3.5 w-3.5" />
                    )}
                    {draftedIds.has(c.id) ? 'Draft another' : 'Draft outreach'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {sourceError && <p className="text-caption text-red-600 dark:text-red-400">{sourceError}</p>}
      {sourceNote && !sourceError && <p className="text-caption text-muted-foreground">{sourceNote}</p>}

      {draftedIds.size > 0 && (
        <p className="text-caption text-muted-foreground">
          <Link href="/queue" className="font-medium text-accent-deep hover:underline">
            Review drafts in the queue
          </Link>{' '}
          — nothing sends until you approve it.
        </p>
      )}
    </div>
  )

  if (variant === 'plain') {
    return (
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-body font-medium text-foreground">
            <Users className="h-4 w-4 text-muted-foreground" />
            Contacts &amp; warm intros
          </h3>
          <SourceButton sourcing={sourcing} onClick={sourceContacts} />
        </div>
        {body}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          Contacts &amp; warm intros
        </CardTitle>
        <SourceButton sourcing={sourcing} onClick={sourceContacts} />
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}
