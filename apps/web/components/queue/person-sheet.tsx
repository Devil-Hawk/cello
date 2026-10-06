'use client'

// The Person sheet: the quick view of a person, from any name in Conversations. Email, Mark contacted today,
// and Open, which goes to the person's page in Network. People live in Network; this is only a window onto one.

import Link from 'next/link'
import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Key } from '@/components/ui/key'
import { callCommand } from '@/lib/network/client'

export interface SheetPerson {
  id: string
  name: string
  title: string | null
  employer: string | null
  email?: string | null
}

export function PersonSheet({ person, onClose }: { person: SheetPerson | null; onClose: () => void }) {
  const [note, setNote] = useState<string | null>(null)

  async function mark() {
    if (!person) return
    try {
      await callCommand('/api/network', 'people.mark_contacted', { id: person.id })
      setNote('Marked as contacted today.')
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save that.')
    }
  }

  return (
    <Dialog open={!!person} onOpenChange={(open) => !open && (setNote(null), onClose())}>
      <DialogContent>
        {person && (
          <>
            <DialogTitle>{person.name}</DialogTitle>
            <DialogDescription>{[person.title, person.employer].filter(Boolean).join(' at ') || 'Employer not known'}</DialogDescription>
            <div className="flex flex-wrap gap-2">
              {person.email && <Key asChild><a href={`mailto:${person.email}`}>Email</a></Key>}
              <Key variant="raised" onClick={mark}>Mark contacted today</Key>
              <Key asChild variant="raised"><Link href={`/network/${person.id}`}>Open</Link></Key>
            </div>
            {note && <p className="r-meta" role="status">{note}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
