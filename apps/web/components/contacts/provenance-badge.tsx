'use client'

// Honest provenance badge for a contact — see supabase/migrations/
// 20260728000007_contact_provenance.sql and lib/contacts/sources.ts for the
// rule this renders: `verified` is true ONLY when a provider (Hunter) ran a
// real deliverability check. A name mention, a quoted posting email, or a
// pattern-guessed address is ALWAYS shown as "Inferred", however confident
// the sourcing pipeline was — never presented as verified.

import { Badge } from '@/components/ui/badge'

export interface ContactProvenance {
  source?: string | null
  verified?: boolean | null
  basis?: string | null
}

const SOURCE_LABEL: Record<string, string> = {
  dossier: 'company research',
  posting: 'the job posting',
  pattern: 'a guessed email pattern',
  hunter: 'Hunter.io',
  apollo: 'Apollo.io',
}

/** Renders nothing for a manually-entered contact (source is null) — that is
 *  simply not an automated-provenance fact worth badging. */
export function ContactProvenanceBadge({ contact, className }: { contact: ContactProvenance; className?: string }) {
  if (!contact.source) return null
  const title = contact.basis ?? `Sourced from ${SOURCE_LABEL[contact.source] ?? contact.source}`
  if (contact.verified) {
    return (
      <Badge tone="good" title={title} className={className}>
        Verified
      </Badge>
    )
  }
  return (
    <Badge tone="warn" title={title} className={className}>
      Inferred, unverified
    </Badge>
  )
}
