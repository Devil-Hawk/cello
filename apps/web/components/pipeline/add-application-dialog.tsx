'use client'

// Add application: one the person made themselves, outside Cello. Company and role title are required; the link,
// the stage and the date it went in are optional. It saves through POST /api/applications { add }, which finds or makes
// the company and the role, so a duplicate comes back as the application that exists.

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Key } from '@/components/ui/key'

export interface NewApplication {
  company: string
  title: string
  url?: string
  stage: string
  appliedAt?: string
}

const STAGES = [
  { id: 'applied', label: 'Applied' },
  { id: 'screen', label: 'Screen' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
]

/** `onAdd` answers with a sentence when it failed, or null when it saved. */
export function AddApplicationDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (a: NewApplication) => Promise<string | null> }) {
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [stage, setStage] = useState('applied')
  const [appliedAt, setAppliedAt] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setNote(null)
    const failed = await onAdd({ company: company.trim(), title: title.trim(), stage, ...(url.trim() ? { url: url.trim() } : {}), ...(appliedAt ? { appliedAt } : {}) })
    setBusy(false)
    if (failed) return setNote(failed)
    setCompany('')
    setTitle('')
    setUrl('')
    setAppliedAt('')
    setStage('applied')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Add application</DialogTitle>
        <DialogDescription>For one you sent outside Cello. It lands in the list and counts in what is working.</DialogDescription>
        <div className="space-y-3">
          <label className="block space-y-1"><span className="r-meta">Company</span><Input value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} /></label>
          <label className="block space-y-1"><span className="r-meta">Role title</span><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="block space-y-1"><span className="r-meta">Link to the posting (optional)</span><Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <div className="flex flex-wrap gap-3">
            <label className="block space-y-1">
              <span className="r-meta">Stage</span>
              <select className="r-field min-h-11" value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            </label>
            <label className="block space-y-1"><span className="r-meta">Applied on (optional)</span><Input type="date" max={new Date().toISOString().slice(0, 10)} value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} /></label>
          </div>
          {note && <p className="r-meta" role="alert">{note}</p>}
          <Key disabled={busy || !company.trim() || !title.trim()} onClick={save}>Add application</Key>
        </div>
      </DialogContent>
    </Dialog>
  )
}
