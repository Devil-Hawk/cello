'use client'

import { Building2, Check, Linkedin, Loader2, Mail, Pencil, Trash2 } from 'lucide-react'
import { calculateConnectionStrength, calculateDaysSinceContact } from '@/lib/contacts/network'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, formatRelativeTime, getInitials } from '@/lib/utils'
import { ContactProvenanceBadge } from './provenance-badge'
import { isPersonalRelationship, RELATIONSHIP_LABELS, type Contact } from './types'

function strengthBarClass(strength: number): string {
  if (strength >= 0.7) return 'bg-emerald-500'
  if (strength >= 0.4) return 'bg-amber-500'
  return 'bg-muted-foreground/40'
}

function strengthLabel(strength: number): string {
  if (strength >= 0.7) return 'Strong'
  if (strength >= 0.4) return 'Moderate'
  return 'Weak'
}

export interface ContactRowProps {
  contact: Contact
  isUpdating: boolean
  onMarkContacted: (contactId: string) => void
  onEdit: (contact: Contact) => void
  onDelete: (contactId: string) => void
}

/** One contact as a table row: identity, company, relationship, strength, last touch, actions. */
export function ContactRow({
  contact,
  isUpdating,
  onMarkContacted,
  onEdit,
  onDelete,
}: ContactRowProps) {
  const daysSinceContact = contact.last_contact_at
    ? calculateDaysSinceContact(new Date(contact.last_contact_at))
    : undefined
  const strength = calculateConnectionStrength(contact.relationship, daysSinceContact)

  return (
    <tr className="group border-b transition-colors last:border-0 hover:bg-sunken/60">
      <td className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sunken text-caption font-medium text-foreground">
            {getInitials(contact.name)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-body font-medium text-foreground">{contact.name}</span>
              <ContactProvenanceBadge contact={contact} className="shrink-0 text-[11px]" />
            </div>
            {contact.email && (
              <a
                href={`mailto:${contact.email}`}
                className="flex items-center gap-1 truncate text-caption text-muted-foreground hover:text-accent-deep hover:underline"
              >
                <Mail className="h-3 w-3 shrink-0" />
                {contact.email}
              </a>
            )}
          </div>
        </div>
      </td>
      <td className="p-4">
        {contact.companies ? (
          <div className="flex items-center gap-2 text-body text-foreground">
            {contact.companies.logo_url ? (
              <img
                src={contact.companies.logo_url}
                alt=""
                className="h-5 w-5 rounded bg-white object-contain"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <Building2 className="h-4 w-4 text-muted-foreground" />
            )}
            {contact.companies.name}
          </div>
        ) : (
          <span className="text-body text-muted-foreground">—</span>
        )}
      </td>
      <td className="p-4 text-body text-muted-foreground">{contact.title || '—'}</td>
      <td className="p-4">
        {isPersonalRelationship(contact.relationship) ? (
          <Badge tone="neutral">
            {RELATIONSHIP_LABELS[contact.relationship as string] || contact.relationship}
          </Badge>
        ) : (
          <span className="text-body text-muted-foreground">—</span>
        )}
      </td>
      <td className="p-4">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
            <div
              className={cn('h-full rounded-full', strengthBarClass(strength))}
              style={{ width: `${strength * 100}%` }}
            />
          </div>
          <span className="text-caption text-muted-foreground">{strengthLabel(strength)}</span>
        </div>
      </td>
      <td className="p-4">
        <div className="flex items-center gap-2 text-body text-muted-foreground">
          <span className="tabular-nums">
            {contact.last_contact_at ? formatRelativeTime(contact.last_contact_at) : 'Never'}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onMarkContacted(contact.id)}
            disabled={isUpdating}
            title="Mark as contacted today"
            aria-label={isUpdating ? `Marking ${contact.name} as contacted…` : `Mark ${contact.name} as contacted today`}
          >
            {isUpdating ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <Check className="h-3 w-3" aria-hidden />
            )}
          </Button>
        </div>
      </td>
      <td className="p-4 text-right">
        <div className="flex items-center justify-end gap-1">
          {contact.email && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => window.open(`mailto:${contact.email}`, '_blank')}
              title="Send email"
              aria-label={`Email ${contact.name}`}
            >
              <Mail className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {contact.linkedin_url && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => window.open(contact.linkedin_url!, '_blank')}
              title="Open LinkedIn profile"
              aria-label={`Open ${contact.name}'s LinkedIn profile`}
            >
              <Linkedin className="h-4 w-4" aria-hidden />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onEdit(contact)}
            title="Edit contact"
            aria-label={`Edit ${contact.name}`}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => onDelete(contact.id)}
            title="Delete contact"
            aria-label={`Delete ${contact.name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </td>
    </tr>
  )
}
