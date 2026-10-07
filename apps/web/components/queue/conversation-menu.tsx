'use client'

// Conversations' menu (blueprint 4.9): Paste an email and Find people at a company. Add a person and Import contacts
// are in Network's menu. Both open a dialog; neither sends anything.

import { useEffect, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Key } from '@/components/ui/key'
import { Textarea } from '@/components/ui/textarea'
import { trackedOnly } from '@/lib/companies/watchlist'
import { callCommand } from '@/lib/network/client'
import { createClient } from '@/lib/supabase/client'

export type MenuDialog = 'paste' | 'find' | null

export function ConversationMenu({ open, onOpen, onSaved }: { open: MenuDialog; onOpen: (d: MenuDialog) => void; onSaved: () => void }) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Key variant="raised" aria-label="Conversations menu"><MoreHorizontal className="h-4 w-4" aria-hidden /></Key>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11 cursor-pointer" onSelect={() => onOpen('paste')}>Paste an email</DropdownMenuItem>
          <DropdownMenuItem className="min-h-11 cursor-pointer" onSelect={() => onOpen('find')}>Find people at a company</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PasteDialog open={open === 'paste'} onClose={() => onOpen(null)} onSaved={onSaved} />
      <FindDialog open={open === 'find'} onClose={() => onOpen(null)} />
    </>
  )
}

/** The dialog a menu item or the Gmail-off state opens; `onSaved` reads the page again. */
function PasteDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setNote(null)
    try {
      await callCommand('/api/conversations', 'conversations.paste', { ...(from.trim() ? { from: from.trim() } : {}), subject: subject.trim().slice(0, 200), body })
      setFrom('')
      setSubject('')
      setBody('')
      onSaved()
      onClose()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save that email.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Paste an email</DialogTitle>
        <DialogDescription>Cello keeps the first lines and who it is from. It waits under Replies waiting on you.</DialogDescription>
        <div className="space-y-3">
          <label className="block space-y-1"><span className="r-meta">From (their address)</span><Input type="email" value={from} onChange={(e) => setFrom(e.target.value)} autoComplete="off" /></label>
          <label className="block space-y-1"><span className="r-meta">Subject</span><Input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="block space-y-1"><span className="r-meta">The email</span><Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          {note && <p className="r-meta" role="alert">{note}</p>}
          <Key disabled={busy || !body.trim()} onClick={save}>Save email</Key>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FindDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [companies, setCompanies] = useState<{ id: string; name: string }[] | null>(null)
  const [id, setId] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || companies) return
    void (async () => {
      try {
        const { data } = await trackedOnly(createClient().from('companies').select('id, name')).order('name').limit(300)
        setCompanies((data ?? []) as { id: string; name: string }[])
      } catch {
        setCompanies([])
      }
    })()
  }, [open, companies])

  async function find() {
    setBusy(true)
    setNote(null)
    try {
      const r = await callCommand<{ company: string; headline: string; inserted: number }>('/api/network', 'people.find', { company_id: id })
      setNote(`${r.headline} Added ${r.inserted} to your network.`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not look for people.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Find people at a company</DialogTitle>
        <DialogDescription>Cello looks for people at the company&apos;s own address. It shows only who it finds, and it never writes to them without your click.</DialogDescription>
        <div className="space-y-3">
          {companies && companies.length === 0 ? (
            <p className="r-body">Add a company to Companies first.</p>
          ) : (
            <label className="block space-y-1">
              <span className="r-meta">Company</span>
              <select className="flex h-9 w-full rounded-control border border-input bg-card px-3 text-body" value={id} onChange={(e) => setId(e.target.value)}>
                <option value="">Choose one</option>
                {(companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {note && <p className="r-meta" role="status">{note}</p>}
          <Key disabled={busy || !id} onClick={find}>Find people</Key>
        </div>
      </DialogContent>
    </Dialog>
  )
}
