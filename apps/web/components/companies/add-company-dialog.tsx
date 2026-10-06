'use client'

// Paste a link on Roles opens Add or find in a dialog, so there is one way to add an employer: companies.add checks
// whose board it is, and nothing unverified is followed.

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AddOrFind } from './add-or-find'

export interface AddCompanyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once an employer was followed, so the caller can read again. */
  onAdded: (companyId?: string) => void
}

export function AddCompanyDialog({ open, onOpenChange, onAdded }: AddCompanyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a company</DialogTitle>
          <DialogDescription>Paste their careers page or a job board link, or type a name to find it.</DialogDescription>
        </DialogHeader>
        <AddOrFind autoFocus onAdded={() => onAdded()} />
      </DialogContent>
    </Dialog>
  )
}
