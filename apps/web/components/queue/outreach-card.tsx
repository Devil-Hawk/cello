'use client'

import { useState } from 'react'
import { Check, Loader2, Mail, Pencil, Send, ShieldAlert, Sparkles, User, X } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { formatShortDate } from '@/lib/format'
import type { EvalResult } from '@/lib/evals/harness'

export interface OutreachRow {
  id: string
  to_email: string
  to_name: string | null
  subject: string
  body: string
  status: 'pending_review' | 'approved' | 'sent' | 'failed' | 'skipped'
  kind: 'initial' | 'follow_up'
  created_at: string
}

const STATUS_TONE: Record<OutreachRow['status'], 'good' | 'warn' | 'bad' | 'neutral' | 'accent'> = {
  pending_review: 'accent',
  approved: 'warn',
  sent: 'good',
  failed: 'bad',
  skipped: 'neutral',
}

const STATUS_LABEL: Record<OutreachRow['status'], string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
}

export function OutreachCard({ message, onChanged }: { message: OutreachRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(message.subject)
  const [body, setBody] = useState(message.body)
  const [busy, setBusy] = useState<null | 'save' | 'send' | 'reject'>(null)
  // The send confirmation step. Deleting a *contact* in this app prompts first;
  // emailing a stranger under the user's own name did not. There is no undo,
  // no delay window and no recall once Gmail has it, so the second look has to
  // happen before the request, not after.
  const [confirming, setConfirming] = useState(false)
  // User-triggered quality check (lib/evals/judge.ts via /api/outreach/judge).
  // Advisory only — never gates or auto-approves the send below. `judging` and
  // `judgeError` are separate from `busy` because a check in flight must not
  // disable Approve & send/Edit/Dismiss; those are independent decisions.
  const [judging, setJudging] = useState(false)
  const [judgeResult, setJudgeResult] = useState<{ groundedness: EvalResult; specificity: EvalResult } | null>(null)
  const [judgeError, setJudgeError] = useState<string | null>(null)

  const pending = message.status === 'pending_review'
  const approved = message.status === 'approved'

  async function save() {
    setBusy('save')
    try {
      const res = await fetch(`/api/outreach/${message.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      setEditing(false)
      // The text just changed — a prior check described a draft that no
      // longer exists.
      setJudgeResult(null)
      setJudgeError(null)
      toast({ title: 'Draft saved' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  // Runs two real, billed model calls (lib/evals/judge.ts's groundedness +
  // specificity scorers) — only ever from this explicit click, never on
  // mount/render/an effect. The result is advisory: it renders below and is
  // never consulted by approveAndSend.
  async function checkDraft() {
    setJudging(true)
    setJudgeError(null)
    try {
      const res = await fetch('/api/outreach/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: message.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not check this draft')
      setJudgeResult({ groundedness: data.groundedness, specificity: data.specificity })
    } catch (e) {
      setJudgeError(e instanceof Error ? e.message : 'Could not check this draft')
    } finally {
      setJudging(false)
    }
  }

  // Approve and send in ONE request, through the user's own Gmail.
  //
  // This used to PATCH the message to 'approved' first and then post to the
  // send route. When the send leg failed — Gmail send permission off (403),
  // daily cap reached (429), Gmail itself erroring (502) — the row was already
  // 'approved', and canSendNow treats 'approved' as sendable unconditionally
  // and forever. The user saw a red toast, believed nothing had happened, and
  // had permanently armed a real email to a real person. The approval now
  // travels WITH the send as `approve: true`, so a failed send leaves the
  // message pending_review, exactly where it started.
  async function approveAndSend() {
    setBusy('send')
    setConfirming(false)
    try {
      const res = await fetch('/api/outreach/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: message.id, approve: pending }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.needsReauth) {
          throw new Error('Gmail access expired — reconnect Gmail in Settings.')
        }
        throw new Error(data.error ?? 'Send failed')
      }
      if (data.skipped) {
        toast({ title: 'Skipped', description: data.reason ?? 'Contact already replied.' })
      } else {
        toast({ title: 'Email sent', description: `to ${message.to_name ?? message.to_email}` })
      }
      onChanged()
    } catch (e) {
      toast({ title: 'Could not send', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function reject() {
    setBusy('reject')
    try {
      const res = await fetch(`/api/outreach/${message.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Reject failed')
      toast({ title: 'Draft dismissed' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-body font-semibold text-foreground">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{message.to_name ?? message.to_email}</span>
          </div>
          {/* The address, at full strength. It was caption-weight muted text —
              the quietest thing on the card — while the display name above it
              got body-semibold. The address is the only string that decides who
              actually receives this, so it reads at foreground weight in mono,
              where a wrong one is obvious at a glance. */}
          <div className="mt-1 inline-flex items-center gap-1.5 text-caption text-foreground">
            <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="break-all font-mono">{message.to_email}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
            <Badge tone="neutral" className="text-[11px]">
              {message.kind === 'follow_up' ? 'Follow-up' : 'Initial'}
            </Badge>
            <span>{formatShortDate(message.created_at)}</span>
          </div>
        </div>
        <Badge tone={STATUS_TONE[message.status]} className="shrink-0">
          {STATUS_LABEL[message.status]}
        </Badge>
      </div>

      <div className="mt-3 space-y-2">
        {editing ? (
          <>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="text-body font-medium" />
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[160px] text-caption" />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSubject(message.subject)
                  setBody(message.body)
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-body font-medium text-foreground">{message.subject}</p>
            {/* Uncapped while a decision is still outstanding. This was
                `max-h-44 overflow-y-auto` with the Send button below it, so a
                400-word email showed ~11 lines and Send was reachable without
                having scrolled one of them — and the well was a <p>, not
                focusable, so a keyboard user could not scroll it at all. Once
                the message is sent or dismissed there is nothing left to judge,
                so history stays capped. */}
            <p
              className={
                pending || approved
                  ? 'whitespace-pre-wrap rounded-control bg-sunken/60 p-3 text-caption text-foreground'
                  : 'max-h-44 overflow-y-auto whitespace-pre-wrap rounded-control bg-sunken/60 p-3 text-caption text-foreground'
              }
            >
              {message.body}
            </p>
          </>
        )}
      </div>

      {/* Quality check — advisory, user-triggered, never a gate on send.
          Stays visible through the confirm step below: a failed groundedness
          check is most useful exactly when the human is one click from
          sending. */}
      {(pending || approved) && !editing && (
        <div className="mt-3">
          {judgeResult ? (
            <div className="space-y-2">
              <JudgeVerdictRow
                label="Groundedness"
                result={judgeResult.groundedness}
                failureWarning="This draft may be lying about the company — it asserts something your resume and the job post don't support."
              />
              <JudgeVerdictRow label="Specificity" result={judgeResult.specificity} />
            </div>
          ) : (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={checkDraft}
                    disabled={judging || busy !== null}
                  >
                    {judging ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {judging ? 'Checking…' : 'Check this draft'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs p-3">
                  <p className="text-caption text-muted-foreground">
                    Two metered AI calls against your own OpenRouter key: one checks the draft only
                    asserts what your resume and this job post support, the other checks it&apos;s
                    actually about this company and role, not boilerplate.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {judgeError && <p className="mt-2 text-caption text-pipeline-rejected">{judgeError}</p>}
        </div>
      )}

      {(pending || approved) && !editing && (
        confirming ? (
          // The second look. There is no undo, no delay window and no recall
          // once Gmail has the message, so the confirmation names the recipient
          // rather than asking "are you sure?" about nothing in particular.
          <div className="mt-4 rounded-control border border-pipeline-screen/40 bg-sunken/60 p-3">
            <p className="text-caption text-foreground">
              Send this now, as you, to{' '}
              <span className="break-all font-mono font-medium">{message.to_email}</span>?
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              It goes out through your own Gmail immediately. It cannot be recalled.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={approveAndSend} disabled={busy !== null} autoFocus>
                {busy === 'send' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Yes, send it
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={busy !== null}
              >
                Keep reviewing
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setConfirming(true)} disabled={busy !== null}>
              <Send className="h-3.5 w-3.5" />
              {approved ? 'Send via Gmail' : 'Approve & send'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy !== null}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={reject} disabled={busy !== null}>
              {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Dismiss
            </Button>
          </div>
        )
      )}
    </Card>
  )
}

/**
 * One judge verdict, rendered better than formatEvalResult's plain-text line
 * (which still exists for anywhere text-only output is fine — this is not a
 * replacement for it). `failureWarning` is only for groundedness: a failed
 * groundedness check means the draft may assert something the resume/job
 * facts don't support, and that reading must be unmistakable, not just a red
 * badge among other red badges.
 */
function JudgeVerdictRow({
  label,
  result,
  failureWarning,
}: {
  label: string
  result: EvalResult
  failureWarning?: string
}) {
  const tone: BadgeTone = result.verdict === 'pass' ? 'good' : result.verdict === 'fail' ? 'bad' : 'muted'
  const mark = result.verdict === 'pass' ? 'Pass' : result.verdict === 'fail' ? 'Fail' : 'Inconclusive'
  const isFailure = result.verdict === 'fail'
  return (
    <div
      className={cn(
        'rounded-control border p-2.5',
        isFailure && failureWarning ? 'border-pipeline-rejected/50 bg-pipeline-rejected/10' : 'bg-sunken/40'
      )}
    >
      <div className="flex items-center gap-1.5">
        {isFailure && failureWarning && <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-pipeline-rejected" />}
        <span className="text-caption font-medium text-foreground">{label}</span>
        <Badge tone={tone} className="text-[11px]">
          {mark}
        </Badge>
      </div>
      {isFailure && failureWarning && (
        <p className="mt-1 text-caption font-semibold text-pipeline-rejected">{failureWarning}</p>
      )}
      <p className="mt-1 text-caption text-muted-foreground">{result.summary}</p>
    </div>
  )
}
