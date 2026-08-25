'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  EMPTY_CONTACT_FORM,
  RELATIONSHIP_OPTIONS,
  type Contact,
  type ContactCompany,
  type ContactFormValues,
  type Relationship,
} from './types'

const NONE_VALUE = '__none__'

export interface ContactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Contact being edited, or null when adding. */
  contact: Contact | null
  companies: ContactCompany[]
  isSaving: boolean
  onSubmit: (values: ContactFormValues) => void
}

/** Add / edit contact dialog built on the shared Dialog primitive. */
export function ContactDialog({
  open,
  onOpenChange,
  contact,
  companies,
  isSaving,
  onSubmit,
}: ContactDialogProps) {
  const [form, setForm] = useState<ContactFormValues>(EMPTY_CONTACT_FORM)

  useEffect(() => {
    if (!open) return
    if (contact) {
      setForm({
        name: contact.name,
        email: contact.email || '',
        companyId: contact.company_id,
        linkedinUrl: contact.linkedin_url || '',
        title: contact.title || '',
        relationship: (contact.relationship as Relationship) || '',
        notes: contact.notes || '',
      })
    } else {
      setForm(EMPTY_CONTACT_FORM)
    }
  }, [open, contact])

  function set<K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{contact ? 'Edit contact' : 'Add contact'}</DialogTitle>
          <DialogDescription>
            {contact
              ? 'Update the details for this contact.'
              : 'Track someone in your network who can open a door.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="contact-name" className="text-body font-medium text-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              id="contact-name"
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="John Doe"
              className="mt-1.5"
            />
          </div>

          <div>
            <label htmlFor="contact-email" className="text-body font-medium text-foreground">
              Email
            </label>
            <Input
              id="contact-email"
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="john@example.com"
              className="mt-1.5"
            />
          </div>

          <div>
            <label className="text-body font-medium text-foreground">Company</label>
            <Select
              value={form.companyId ?? NONE_VALUE}
              onValueChange={(value) => set('companyId', value === NONE_VALUE ? null : value)}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue placeholder="Select a company…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>No company</SelectItem>
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-caption text-muted-foreground">
              Choose from your tracked companies
            </p>
          </div>

          <div>
            <label htmlFor="contact-title" className="text-body font-medium text-foreground">
              Title / role
            </label>
            <Input
              id="contact-title"
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Software Engineer"
              className="mt-1.5"
            />
          </div>

          <div>
            <label htmlFor="contact-linkedin" className="text-body font-medium text-foreground">
              LinkedIn URL
            </label>
            <Input
              id="contact-linkedin"
              type="url"
              value={form.linkedinUrl}
              onChange={(e) => set('linkedinUrl', e.target.value)}
              placeholder="https://linkedin.com/in/johndoe"
              className="mt-1.5"
            />
          </div>

          <div>
            <label className="text-body font-medium text-foreground">Relationship</label>
            <Select
              value={form.relationship || NONE_VALUE}
              onValueChange={(value) =>
                set('relationship', value === NONE_VALUE ? '' : (value as Relationship))
              }
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue placeholder="Select relationship type…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Not set</SelectItem>
                {RELATIONSHIP_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label htmlFor="contact-notes" className="text-body font-medium text-foreground">
              Notes
            </label>
            <textarea
              id="contact-notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Any notes about this contact…"
              rows={3}
              className="mt-1.5 flex w-full resize-none rounded-control border border-input bg-card px-3 py-2 text-body text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(form)} disabled={!form.name.trim() || isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {contact ? 'Save changes' : 'Add contact'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
