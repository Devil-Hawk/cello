'use client'

import { autoSubmitEnabled } from '@/lib/automation/capabilities'
import { useCallback, useEffect, useState } from 'react'
import { Inbox, Mail, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { DraftCard, type DraftRow } from '@/components/queue/draft-card'
import { OutreachCard, type OutreachRow } from '@/components/queue/outreach-card'
import { createClient } from '@/lib/supabase/client'

type Tab = 'applications' | 'outreach'
type ScopeFilter = 'pending' | 'all'

interface Policy {
  autoSubmit: boolean
  autoSend: boolean
  dailyCap: number
}

export default function QueuePage() {
  const [tab, setTab] = useState<Tab>('applications')
  const [scope, setScope] = useState<ScopeFilter>('pending')
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [messages, setMessages] = useState<OutreachRow[]>([])
  const [policy, setPolicy] = useState<Policy>({ autoSubmit: false, autoSend: false, dailyCap: 10 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [draftsRes, outreachRes] = await Promise.all([
        fetch('/api/drafts?limit=100'),
        fetch('/api/outreach?limit=100'),
      ])
      const draftsData = await draftsRes.json()
      const outreachData = await outreachRes.json()
      if (Array.isArray(draftsData.drafts)) setDrafts(draftsData.drafts as DraftRow[])
      if (Array.isArray(outreachData.messages)) setMessages(outreachData.messages as OutreachRow[])
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Policy read for the info banner (from the user's own profile preferences).
    ;(async () => {
      try {
        const supabase = createClient()
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (!user) return
        const { data: profile } = await supabase
          .from('profiles')
          .select('preferences')
          .eq('id', user.id)
          .single()
        const p = (profile?.preferences ?? {}) as Record<string, unknown>
        const outreach = (p.outreach ?? {}) as Record<string, unknown>
        setPolicy({
          autoSubmit: p.autoSubmit === true || p.autoApply === true,
          autoSend: outreach.autoSend === true,
          dailyCap: typeof outreach.dailyCap === 'number' ? outreach.dailyCap : 10,
        })
      } catch {
        /* policy banner is optional */
      }
    })()
  }, [load])

  const visibleDrafts = drafts.filter((d) =>
    scope === 'pending' ? d.status === 'pending_review' : d.status !== 'rejected'
  )
  const visibleMessages = messages.filter((m) =>
    scope === 'pending' ? m.status === 'pending_review' || m.status === 'approved' : m.status !== 'skipped'
  )

  const pendingDrafts = drafts.filter((d) => d.status === 'pending_review').length
  const pendingOutreach = messages.filter(
    (m) => m.status === 'pending_review' || m.status === 'approved'
  ).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-title text-foreground">Queue</h1>
          <p className="mt-1 text-caption text-muted-foreground">
            Review and approve applications and outreach before anything leaves your account.
          </p>
        </div>
        <Segmented<ScopeFilter>
          value={scope}
          onValueChange={setScope}
          aria-label="Filter queue"
          options={[
            { value: 'pending', label: 'Needs review' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      {/* Policy banner */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-card border bg-sunken/50 px-4 py-2.5 text-caption text-muted-foreground">
        {/* Derived from policy.autoSend, NOT hardcoded. This span used to read
            "Human-approve is on" with a green shield as fixed JSX, sourced from
            no state at all — four spans to the left of "Auto-send outreach: on".
            When autoSend is true, canSendNow (lib/outreach/guardrails.ts) sends
            a pending_review message with no human approval, so the page could
            display a safety promise it was actively not keeping. This is the
            same failure lib/automation/capabilities.ts was written to eliminate
            for auto-submit; it just never got applied to the switch that emails
            real people. */}
        {policy.autoSend ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <ShieldAlert className="h-3.5 w-3.5 text-pipeline-screen" />
            Auto-send is on — outreach can leave without your approval
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-pipeline-offer" />
            Human-approve is on
          </span>
        )}
        {/* Reports the CAPABILITY, not the stored preference. Accounts created
            while the onboarding switch existed may still carry
            `autoSubmit: true`, and echoing that back would repeat the original
            lie. See lib/automation/capabilities.ts. */}
        <span>
          Auto-submit applications:{' '}
          <span className="font-medium text-foreground">
            {autoSubmitEnabled(policy.autoSubmit) ? 'on' : 'off'}
          </span>
        </span>
        <span>
          Auto-send outreach:{' '}
          <span className="font-medium text-foreground">{policy.autoSend ? 'on' : 'off'}</span>
        </span>
        <span>
          Daily email cap: <span className="font-medium text-foreground">{policy.dailyCap}</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Segmented<Tab>
          value={tab}
          onValueChange={setTab}
          aria-label="Queue type"
          options={[
            {
              value: 'applications',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Applications
                  {pendingDrafts > 0 && <Badge tone="accent" className="text-[11px]">{pendingDrafts}</Badge>}
                </span>
              ),
            },
            {
              value: 'outreach',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Outreach
                  {pendingOutreach > 0 && <Badge tone="accent" className="text-[11px]">{pendingOutreach}</Badge>}
                </span>
              ),
            },
          ]}
        />
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-52 w-full" />
          ))}
        </div>
      ) : tab === 'applications' ? (
        visibleDrafts.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No application drafts to review"
            body="When the apply agent tailors a CV for a matched role, the draft lands here for your approval before anything is submitted."
          />
        ) : (
          <div className="space-y-4">
            {visibleDrafts.map((d) => (
              <DraftCard key={d.id} draft={d} onChanged={load} />
            ))}
          </div>
        )
      ) : visibleMessages.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No outreach to review"
          body="Personalized intro emails to contacts from your own Gmail graph appear here. Nothing sends until you approve it — one email per contact, per role."
        />
      ) : (
        <div className="space-y-4">
          {visibleMessages.map((m) => (
            <OutreachCard key={m.id} message={m} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  )
}
