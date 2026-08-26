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
//
// The list is RANKED, not chronological: sourcing mines a company's own pages,
// which is where companies put their executives, so an unranked result is a
// list of people who will never reply — unless the company is small enough
// that its founder does the hiring. lib/contacts/relevance.ts makes that call
// from the company's open-role count (GET /api/contacts/source supplies it),
// ranked-contacts.tsx renders the groups and the per-row reason.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mail, Sparkles, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import type { SearchReport } from '@/lib/contacts/sources'
import type { RoleContext } from '@/lib/contacts/relevance'
import { RankedContactList, type RankableContact } from './ranked-contacts'
import { ContactSearchReport } from './search-report'
import { isPersonalRelationship, RELATIONSHIP_LABELS } from './types'

type NetworkContact = RankableContact

/**
 * What the ranking assumes when the role context could not be read at all.
 * `openRoleCount: null` is relevance.ts's honest "unknown", which it treats as
 * small — so a startup founder is never buried by a failed lookup, and every
 * reason string says "company size unknown" out loud.
 */
const UNKNOWN_ROLE: RoleContext = { jobFunction: null, jobTitle: null, openRoleCount: null }

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
  const [searchReport, setSearchReport] = useState<SearchReport | null>(null)
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  const [role, setRole] = useState<RoleContext | null>(null)
  const [roleBasis, setRoleBasis] = useState<string | null>(null)
  const [draftingId, setDraftingId] = useState<string | null>(null)
  const [draftedIds, setDraftedIds] = useState<Set<string>>(new Set())

  // The ranking inputs — read on mount so contacts sourced on an EARLIER run
  // are ranked too, not just the ones this session happens to find. A failure
  // here is deliberately not surfaced as an error: ranking degrades to
  // "company size unknown", which relevance.ts states in every reason string.
  const loadRole = useCallback(async () => {
    try {
      const params = new URLSearchParams({ companyId })
      if (jobId) params.set('jobId', jobId)
      const res = await fetch(`/api/contacts/source?${params.toString()}`)
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.role) return
      setRole(data.role as RoleContext)
      setRoleBasis(typeof data.roleBasis === 'string' ? data.roleBasis : null)
    } catch {
      // Keep the unknown-size default; nothing here is worth an error banner.
    }
  }, [companyId, jobId])

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
    loadRole()
  }, [load, loadRole])

  async function sourceContacts() {
    setSourcing(true)
    setSourceError(null)
    setSourceNote(null)
    setSearchReport(null)
    try {
      const res = await fetch('/api/contacts/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, jobId }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.error ?? `Contact sourcing failed (HTTP ${res.status})`)
      // The route reports what it searched (SearchReport) — render THAT, never
      // a canned "nothing usable" sentence that is indistinguishable from a
      // broken button. The count-only fallback below exists solely for a
      // server old enough to predate the report; it still claims nothing about
      // what was searched.
      if (data.search) {
        setSearchReport(data.search as SearchReport)
      } else {
        const insertedCount = Array.isArray(data.inserted) ? data.inserted.length : 0
        setSourceNote(
          insertedCount > 0
            ? `Found ${insertedCount} new contact${insertedCount === 1 ? '' : 's'} from public sources.`
            : 'No new contacts were added.'
        )
      }
      if (data.role) {
        setRole(data.role as RoleContext)
        setRoleBasis(typeof data.roleBasis === 'string' ? data.roleBasis : null)
      }
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

  const allContacts = contacts ?? []
  const warmContacts = allContacts.filter((c) => isPersonalRelationship(c.relationship))

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
      ) : allContacts.length === 0 ? (
        // Once a run has reported back, the report IS the empty state — it
        // says what was searched. Telling the user to "source some from public
        // data" underneath it would be advice they just took.
        !loadError &&
        !searchReport && (
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

          <RankedContactList
            contacts={allContacts}
            role={role ?? UNKNOWN_ROLE}
            renderAction={(c) =>
              c.email ? (
                <Button size="sm" variant="outline" disabled={draftingId === c.id} onClick={() => draftOutreach(c)}>
                  {draftingId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mail className="h-3.5 w-3.5" />
                  )}
                  {draftedIds.has(c.id) ? 'Draft another' : 'Draft outreach'}
                </Button>
              ) : null
            }
          />

          {/* The ranking's own inputs, stated: which role it ranked for, and
              the company-size proxy that decides whether a founder leads the
              list or ends it. */}
          <p className="text-caption text-muted-foreground">
            Ranked for {role?.jobTitle ?? 'this role'} · {roleBasis ?? 'company size unknown'}
          </p>
        </>
      )}

      {sourceError && <p className="text-caption text-red-600 dark:text-red-400">{sourceError}</p>}
      {/* Sunken, not accent: the report is provenance for the run that just
          finished, not a live signal — and it sits under the contact list, so
          it needs to read as a distinct region rather than more list. */}
      {searchReport && !sourceError && (
        <Panel tone="sunken" divider="none" className="rounded-control">
          <ContactSearchReport report={searchReport} />
        </Panel>
      )}
      {sourceNote && !sourceError && !searchReport && (
        <p className="text-caption text-muted-foreground">{sourceNote}</p>
      )}

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
