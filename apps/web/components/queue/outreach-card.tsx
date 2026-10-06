'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, CornerDownRight, Info, ListChecks, Loader2, Mail, Pencil, RotateCcw, Send, ShieldAlert, User, X } from 'lucide-react'
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
import type { StoredOutreachVerdict } from '@/lib/outreach/verdicts'
import type { TemplateReason } from '@/lib/outreach/types'
import { templateNotice } from '@/lib/outreach/template-notice'
import { checkDraft as runDraftChecks } from '@/lib/writing/checks'
import { DraftChecks } from '@/components/writing/draft-checks'

export interface OutreachRow {
  id: string
  to_email: string
  to_name: string | null
  subject: string
  body: string
  status: 'pending_review' | 'approved' | 'sent' | 'failed' | 'skipped'
  kind: 'initial' | 'follow_up'
  parent_id?: string | null
  created_at: string
  /** Why a send failed (status 'failed'), in Gmail's own words. */
  error?: string | null
  sent_at?: string | null
  /** Set by the Gmail reply sync once the contact has answered. */
  replied_at?: string | null
  reply_classification?: 'positive' | 'neutral' | 'negative' | 'bounce' | null
  /** False when no model wrote this draft (the standard template). */
  used_llm?: boolean | null
  /** Why it is the template. Null on rows from before the reason was recorded. */
  template_reason?: TemplateReason | null
  /** The user's full name, the only valid sign-off. */
  sender_name?: string | null
  company_name?: string | null
  /** True when there is recorded earlier contact with this person or company. */
  has_history?: boolean
  /** For a follow-up: the first email's body, which a follow-up must be shorter than. */
  parent_body?: string | null
  /** Quality-check verdicts already stored for this draft. */
  verdicts?: StoredOutreachVerdict[]
}

const REPLY_LABEL: Record<NonNullable<OutreachRow['reply_classification']>, { text: string; tone: BadgeTone }> = {
  positive: { text: 'Replied (positive)', tone: 'good' },
  neutral: { text: 'Replied', tone: 'good' },
  negative: { text: 'Replied (declined)', tone: 'neutral' },
  bounce: { text: 'Bounced, the address did not accept it', tone: 'bad' },
}

/** A stored verdict as the same row shape a live check renders. */
function storedAsResult(v: StoredOutreachVerdict | undefined): Pick<EvalResult, 'verdict' | 'summary'> | null {
  if (!v) return null
  return {
    verdict: v.verdict as EvalResult['verdict'],
    summary: v.rationale ?? (v.verdict === 'pass' ? 'Passed.' : 'No detail was recorded.'),
  }
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

export function OutreachCard({
  message,
  onChanged,
  followUpDue = false,
}: {
  message: OutreachRow
  onChanged: () => void
  /** The page's call: sent, unanswered, past the wait window, and no follow-up drafted yet. */
  followUpDue?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(message.subject)
  const [body, setBody] = useState(message.body)
  const [busy, setBusy] = useState<null | 'save' | 'send' | 'reject' | 'retry' | 'followup'>(null)
  // A send that did not go out and is worth reading twice, kept on the card
  // (the toast is gone in seconds). `reauth` adds the link that fixes it.
  const [sendError, setSendError] = useState<{ message: string; reauth: boolean } | null>(null)
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
  const [edited, setEdited] = useState(false)

  const pending = message.status === 'pending_review'
  const approved = message.status === 'approved'
  const failed = message.status === 'failed'
  const sent = message.status === 'sent'
  // Stored verdicts describe the text as drafted. Once this card's text has been
  // edited they no longer do (the server stops sending them on the next load).
  const stored = edited ? [] : message.verdicts ?? []
  const storedGround = storedAsResult(stored.find((v) => v.judge === 'groundedness'))
  const storedSpecific = storedAsResult(stored.find((v) => v.judge === 'specificity'))
  // A check has been run for this draft (stored, or just now) but the text
  // changed since: say so instead of leaving rows that describe other words.
  const checkedBefore = (message.verdicts ?? []).some((v) => v.judge !== 'deterministic') || judgeResult !== null
  const textChanged = edited || (editing && (subject !== message.subject || body !== message.body))
  // The checks code can run, recomputed on every keystroke while editing.
  const liveChecks = runDraftChecks({
    kind: message.kind === 'follow_up' ? 'follow_up' : 'outreach',
    subject: editing ? subject : message.subject,
    body: editing ? body : message.body,
    senderName: message.sender_name,
    contactName: message.to_name,
    companyName: message.company_name,
    hasHistory: message.kind === 'follow_up' ? true : message.has_history ?? false,
    previousBody: message.parent_body ?? null,
  }).checks
  const notice = message.used_llm === false ? templateNotice(message.template_reason) : null

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
      setEdited(true)
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
        const text = data.error ?? 'Send failed'
        // The draft is untouched when the credential was the problem: say what
        // to do, and keep saying it until the user acts.
        setSendError({ message: text, reauth: data.needsReauth === true })
        throw new Error(text)
      }
      setSendError(null)
      if (data.skipped) {
        toast({ title: 'Skipped', description: data.reason ?? 'Contact already replied.' })
      } else if (data.warning) {
        toast({ title: 'Email sent', description: data.warning })
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

  // A failed send goes back to the review state with its error cleared; it
  // still needs the human's Approve & send to go out again.
  async function retry() {
    setBusy('retry')
    try {
      const res = await fetch(`/api/outreach/${message.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Retry failed')
      setSendError(null)
      toast({ title: 'Back in review', description: 'Review it and send when you are ready.' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  // One polite follow-up, drafted into the same review queue.
  async function draftFollowUp() {
    setBusy('followup')
    try {
      const res = await fetch('/api/outreach/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: message.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Could not draft a follow-up')
      if (data.skipped) {
        toast({ title: 'No follow-up needed', description: `${message.to_name ?? message.to_email} already replied.` })
      } else if (data.usedLlm === false) {
        const n = templateNotice(data.templateReason)
        toast({ title: n.title, description: n.body, variant: 'destructive' })
      } else {
        toast({ title: 'Follow-up drafted', description: 'It is waiting for your review.' })
      }
      onChanged()
    } catch (e) {
      toast({ title: 'Could not draft a follow-up', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
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
            {sent && message.sent_at && <span>Sent {formatShortDate(message.sent_at)}</span>}
            {sent &&
              (message.replied_at ? (
                <Badge tone={REPLY_LABEL[message.reply_classification ?? 'neutral'].tone} className="text-[11px]">
                  {REPLY_LABEL[message.reply_classification ?? 'neutral'].text}
                </Badge>
              ) : (
                <span>No reply yet</span>
              ))}
          </div>
        </div>
        <Badge tone={STATUS_TONE[message.status]} className="shrink-0">
          {STATUS_LABEL[message.status]}
        </Badge>
      </div>

      {/* A template is never shown as a written draft: a visible block, not a
          tooltip, so it reads on a phone too, with the reason and the next step. */}
      {notice && (pending || approved) && (
        <div className="mt-3 flex items-start gap-2 rounded-control border bg-sunken/40 p-2.5" role="note">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-caption font-semibold text-foreground">{notice.title}</p>
            <p className="mt-0.5 text-caption text-muted-foreground">{notice.body}</p>
          </div>
        </div>
      )}

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

      {failed && (
        <div className="mt-3 rounded-control border border-pipeline-rejected/50 bg-pipeline-rejected/10 p-3" role="alert">
          <p className="flex items-center gap-1.5 text-caption font-semibold text-pipeline-rejected">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> This email did not go out
          </p>
          <p className="mt-1 break-words text-caption text-foreground">{message.error ?? 'Gmail did not accept it.'}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={retry} disabled={busy !== null}>
              {busy === 'retry' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={reject} disabled={busy !== null}>
              {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {sent && followUpDue && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={draftFollowUp} disabled={busy !== null}>
            {busy === 'followup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerDownRight className="h-3.5 w-3.5" />}
            Draft follow-up
          </Button>
          <span className="text-caption text-muted-foreground">No reply yet. One polite nudge is allowed.</span>
        </div>
      )}

      {/* Checks. The first list is code (length, filler, one ask, greeting,
          sign-off) and recomputes as the text changes. The two rows below it
          are the model check, run when the draft was written or on request;
          after an edit they describe other words, so they say so. Advisory,
          user-triggered, never a gate on send, and kept visible through the
          confirm step: a failed check matters most one click before sending. */}
      {(pending || approved) && (
        <div className="mt-3 space-y-2">
          <DraftChecks checks={liveChecks} />
          {!editing &&
            (textChanged && checkedBefore ? (
              <div className="rounded-control border bg-sunken/40 p-2.5">
                <p className="text-caption text-muted-foreground">Edited after the check.</p>
                <Button size="sm" variant="ghost" className="mt-1" onClick={checkDraft} disabled={judging || busy !== null}>
                  {judging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                  {judging ? 'Checking' : 'Check again (two model calls on your key)'}
                </Button>
              </div>
            ) : judgeResult || storedGround || storedSpecific ? (
              <div className="space-y-2">
                {/* A fresh check wins; otherwise what was stored when the draft
                    was written. Nothing re-runs, so showing them costs nothing. */}
                {(judgeResult?.groundedness ?? storedGround) && (
                  <JudgeVerdictRow label="Backed by your resume" result={(judgeResult?.groundedness ?? storedGround)!} claims />
                )}
                {(judgeResult?.specificity ?? storedSpecific) && (
                  <JudgeVerdictRow label="Specific to this role" result={(judgeResult?.specificity ?? storedSpecific)!} />
                )}
                {!judgeResult && (
                  <Button size="sm" variant="ghost" onClick={checkDraft} disabled={judging || busy !== null}>
                    {judging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                    {judging ? 'Checking' : 'Check again (two model calls on your key)'}
                  </Button>
                )}
              </div>
            ) : notice ? null : (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="outline" onClick={checkDraft} disabled={judging || busy !== null}>
                      {judging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
                      {judging ? 'Checking' : 'Check this draft'}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs p-3">
                    <p className="text-caption text-muted-foreground">
                      Two model calls on your own key: one checks every statement traces to your resume or the job
                      post, the other checks the draft is about this role and company, not boilerplate.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          {judgeError && <p className="text-caption text-pipeline-rejected">{judgeError}</p>}
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
      {sendError && (
        <p className="mt-3 text-caption text-pipeline-rejected" role="alert">
          {sendError.message}{' '}
          {sendError.reauth && (
            <Link href="/settings?tab=connections" className="font-medium underline">
              Open Gmail settings
            </Link>
          )}
        </p>
      )}
    </Card>
  )
}

/**
 * One model verdict as a labelled row. For the claims check (`claims`), a
 * failure lists each statement no source line backs, quoted, and says what to
 * do next, so the user can fix the lines instead of guessing which one it was.
 */
function JudgeVerdictRow({
  label,
  result,
  claims = false,
}: {
  label: string
  result: Pick<EvalResult, 'verdict' | 'summary'>
  claims?: boolean
}) {
  const tone: BadgeTone = result.verdict === 'pass' ? 'good' : result.verdict === 'fail' ? 'bad' : 'muted'
  const mark = result.verdict === 'pass' ? 'Pass' : result.verdict === 'fail' ? 'Fail' : 'Not checked'
  const isFailure = result.verdict === 'fail'
  const unsupported = claims && isFailure ? result.summary.split(/(?=Not in your sources: )/).map((s) => s.trim()).filter(Boolean) : []
  return (
    <div className={cn('rounded-control border p-2.5', isFailure && claims ? 'border-pipeline-rejected/50 bg-pipeline-rejected/10' : 'bg-sunken/40')}>
      <div className="flex items-center gap-1.5">
        {isFailure && claims && <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-pipeline-rejected" />}
        <span className="text-caption font-medium text-foreground">{label}</span>
        <Badge tone={tone} className="text-[11px]">
          {mark}
        </Badge>
      </div>
      {unsupported.length > 0 ? (
        <>
          <ul className="mt-1 space-y-1">
            {unsupported.map((line) => (
              <li key={line} className="break-words text-caption text-foreground">
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-caption font-semibold text-pipeline-rejected">Edit the draft or remove these lines before sending.</p>
        </>
      ) : (
        <p className="mt-1 text-caption text-muted-foreground">{result.summary}</p>
      )}
    </div>
  )
}
