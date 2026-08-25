'use client'

import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'

export interface DigestCardProps {
  initialEnabled: boolean
  /** Whether today's composed digest has anything actionable (controls "Send now"). */
  hasContent: boolean
}

/**
 * Opt-in card for the daily digest email. Default OFF. Toggling persists the
 * flag via POST /api/digest; "Send me today's digest" triggers a one-off send
 * through the user's own Gmail via POST /api/digest/send (request context).
 */
export function DigestCard({ initialEnabled, hasContent }: DigestCardProps) {
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)

  const toggle = async () => {
    const next = !enabled
    setSaving(true)
    try {
      const res = await fetch('/api/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error('save failed')
      setEnabled(next)
      toast({
        title: next ? 'Daily digest on' : 'Daily digest off',
        description: next
          ? 'You will get a once-a-day summary of top matches and follow-ups.'
          : 'You will no longer receive the daily digest.',
      })
    } catch {
      toast({ title: 'Could not save', description: 'Please try again.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const sendNow = async () => {
    setSending(true)
    try {
      const res = await fetch('/api/digest/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data?.needsReauth) {
          toast({
            title: 'Gmail access needed',
            description: 'Connect Gmail in Settings to enable this. to email yourself the digest.',
            variant: 'destructive',
          })
        } else {
          throw new Error(data?.error || 'send failed')
        }
        return
      }
      toast({
        title: data.outcome === 'sent' ? 'Digest sent' : 'Digest ready',
        description:
          data.outcome === 'sent'
            ? 'Check your inbox — it came from your own Gmail.'
            : 'Nothing actionable to email today, but it is saved here.',
      })
    } catch (e) {
      toast({
        title: 'Could not send',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sunken">
              <Mail className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <CardTitle>Daily digest email</CardTitle>
              <CardDescription className="mt-1">
                A once-a-day summary of your top matches, interviews to prep for, and follow-ups
                due — composed from your own data, sent from your own Gmail.
              </CardDescription>
            </div>
          </div>
          <Badge tone={enabled ? 'good' : 'neutral'} className="shrink-0">
            {enabled ? 'On' : 'Off'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Button variant={enabled ? 'outline' : 'default'} onClick={toggle} disabled={saving}>
          {saving ? 'Saving…' : enabled ? 'Turn off' : 'Turn on daily digest'}
        </Button>
        <Button variant="ghost" onClick={sendNow} disabled={sending || !hasContent}>
          {sending ? 'Sending…' : 'Send me today’s digest'}
        </Button>
        {!hasContent && (
          <span className="text-caption text-muted-foreground">
            Nothing to send today — check back once you have matches or follow-ups.
          </span>
        )}
      </CardContent>
    </Card>
  )
}
