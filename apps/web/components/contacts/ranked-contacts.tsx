'use client'

// Sourced contacts, grouped by WHO CAN ACTUALLY MOVE THIS APPLICATION.
//
// WHY THIS EXISTS
//   Contact sourcing scrapes a company's own pages, and that is where
//   companies put their executives — so an unranked list is a list of CEOs.
//   At a 7,000-person company those are the least useful people alive to a
//   candidate; at a twelve-person startup the founder IS the hiring path.
//   lib/contacts/relevance.ts encodes that judgement; this component is the
//   half that makes it visible: every row carries the reason it sits where it
//   does, and the groups are headed so the useful people cannot be missed.
//
//   Kept separate from contact-network-panel.tsx (which owns fetching,
//   drafting and error state) so the ranked rendering can be tested by
//   rendering it directly — see ranked-contacts.test.tsx.

import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  groupRankedContacts,
  isLeadableBucket,
  rankContactsForRole,
  type RoleContext,
} from '@/lib/contacts/relevance'
import { ContactProvenanceBadge } from './provenance-badge'
import { isPersonalRelationship, RELATIONSHIP_LABELS } from './types'

export interface RankableContact {
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

export function RankedContactList({
  contacts,
  role,
  renderAction,
}: {
  contacts: readonly RankableContact[]
  /** The role being pursued — decides whether a founder ranks first or last. */
  role: RoleContext
  /** Per-row action (drafting outreach lives in the panel, not here). */
  renderAction?: (contact: RankableContact) => ReactNode
}) {
  // Someone the user actually knows outranks a stranger with the same title,
  // and rankContactsForRole's sort is stable — so putting personal
  // relationships first here survives the ranking as a tie-break inside each
  // bucket, without giving a friend in sales a better bucket than the
  // recruiter who owns the req.
  const warmFirst = [
    ...contacts.filter((c) => isPersonalRelationship(c.relationship)),
    ...contacts.filter((c) => !isPersonalRelationship(c.relationship)),
  ]
  const groups = groupRankedContacts(rankContactsForRole(warmFirst, role))

  return (
    <div className="space-y-3">
      {groups.map((group, groupIndex) => {
        // Only the FIRST group gets the live-signal accent, and only when its
        // bucket is one a user should act on. When a big company's pages
        // yielded nothing but executives, the best group is still people who
        // will not answer — accenting it would restate the exact lie the
        // ranking exists to correct.
        const lead = groupIndex === 0 && isLeadableBucket(group.bucket)
        return (
          <section key={group.bucket}>
            <div className="flex items-baseline gap-2 border-b pb-1">
              <h4
                className={cn(
                  'text-caption font-medium uppercase tracking-wide',
                  lead ? 'text-accent-deep' : 'text-muted-foreground'
                )}
              >
                {group.label}
              </h4>
              <span className="text-caption tabular-nums text-muted-foreground">{group.contacts.length}</span>
            </div>
            <ul className="divide-y">
              {group.contacts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
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
                    <p className="text-caption text-muted-foreground">{c.relevance.reason}</p>
                  </div>
                  {renderAction?.(c)}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
