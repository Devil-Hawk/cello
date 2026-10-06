'use client'

import { useState } from 'react'
import { Check, MoreHorizontal, ThumbsDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ToastAction } from '@/components/ui/toast'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'

export type TriageReaction = 'interested' | 'not_for_me' | 'applied'
export type TriageReason = 'too_junior' | 'too_senior' | 'company' | 'domain' | 'location' | 'relocation' | 'agency' | 'sponsorship' | 'pay' | 'other'

const REASONS: { value: TriageReason; label: string }[] = [
  { value: 'too_junior', label: 'Too junior' },
  { value: 'too_senior', label: 'Too senior' },
  { value: 'company', label: 'Company' },
  { value: 'domain', label: 'Domain' },
  { value: 'location', label: 'Location' },
  { value: 'relocation', label: 'Needs relocation' },
  { value: 'agency', label: 'Agency posting' },
  { value: 'sponsorship', label: 'No sponsorship' },
  { value: 'pay', label: 'Pay' },
  { value: 'other', label: 'Other' },
]

export interface TriageControlProps {
  jobId: string
  /** Where the person is looking at the role, so learning can tell a shortlist pick from browsing. */
  surface: 'roles' | 'record' | 'today' | 'applications' | 'company' | 'chat'
  /** An exploration pick is marked, so what is learned from it is weighed that way. */
  pickKind?: 'top' | 'explore' | null
  /** What the person already said about this role. */
  reaction?: { reaction: TriageReaction; reason?: TriageReason | null } | null
  /** Called after the server accepted the reaction, or after it was taken back (null). */
  onChange?: (next: { reaction: TriageReaction; reason: TriageReason | null } | null) => void
  className?: string
}

async function send(jobId: string, body: Record<string, unknown>): Promise<{ message: string } | { error: string }> {
  try {
    const res = await fetch(`/api/roles/${jobId}/reaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    return res.ok && json.message ? { message: json.message } : { error: json.error ?? 'Could not save that.' }
  } catch {
    return { error: 'Could not save that. Check your connection and try again.' }
  }
}

/**
 * Interested and Not for me on a role, with an optional one-tap reason after a
 * pass, and Applied in the overflow. Every tap is confirmed with a short message and an
 * Undo. On a phone the two buttons are full-width halves at 44px.
 */
export function TriageControl({ jobId, surface, pickKind = null, reaction = null, onChange, className }: TriageControlProps) {
  const [current, setCurrent] = useState<{ reaction: TriageReaction; reason: TriageReason | null } | null>(reaction ? { reaction: reaction.reaction, reason: reaction.reason ?? null } : null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  async function undo() {
    setBusy(true)
    try {
      const res = await fetch(`/api/roles/${jobId}/reaction`, { method: 'DELETE' })
      if (res.ok) {
        setCurrent(null)
        setAsking(false)
        onChange?.(null)
      }
    } finally {
      setBusy(false)
    }
  }

  async function react(next: TriageReaction, reason: TriageReason | null = null) {
    if (busy) return
    // Tapping the reaction that is already set takes it back.
    if (current?.reaction === next && !reason) return undo()
    setBusy(true)
    const out = await send(jobId, { reaction: next, reason, surface, pickKind })
    setBusy(false)
    if ('error' in out) {
      toast({ title: 'Could not save that', description: out.error, variant: 'destructive' })
      return
    }
    setCurrent({ reaction: next, reason })
    setAsking(next === 'not_for_me' && !reason)
    onChange?.({ reaction: next, reason })
    toast({
      title: out.message,
      action: (
        <ToastAction altText="Undo" onClick={() => void undo()}>
          Undo
        </ToastAction>
      ),
    })
  }

  const on = (r: TriageReaction) => current?.reaction === r
  return (
    <div className={cn('flex flex-col gap-2', className)} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant={on('interested') ? 'cello' : 'outline'} aria-pressed={on('interested')} disabled={busy} onClick={() => void react('interested')} className="h-11 flex-1 sm:h-8 sm:flex-none">
          <Check className="h-4 w-4" aria-hidden="true" />
          Interested
        </Button>
        <Button type="button" size="sm" variant={on('not_for_me') ? 'secondary' : 'outline'} aria-pressed={on('not_for_me')} disabled={busy} onClick={() => void react('not_for_me')} className="h-11 flex-1 sm:h-8 sm:flex-none">
          <ThumbsDown className="h-4 w-4" aria-hidden="true" />
          Not for me
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" variant="ghost" aria-label="More ways to respond" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8">
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void react('applied')}>I applied to this role</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {asking && current?.reaction === 'not_for_me' && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Why is it not for you?">
          {REASONS.map((r) => (
            <Button key={r.value} type="button" size="sm" variant="outline" className="h-9 sm:h-7" disabled={busy} onClick={() => void react('not_for_me', r.value)}>
              {r.label}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" className="h-9 sm:h-7" onClick={() => setAsking(false)}>
            Skip
          </Button>
        </div>
      )}
    </div>
  )
}
