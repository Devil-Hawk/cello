'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RotateCw,
  ShieldOff,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AccessCodeActivity } from '@/components/settings/access-code-activity'
import type { AccessCodeStatus, AccessCodeSummary } from '@/app/api/access-codes/contract'

// `import type` above is load-bearing: contract.ts transitively imports
// node:crypto (via lib/access/codes.ts), so a value import would drag crypto
// into the browser bundle. Types are erased at compile time.

export interface AccessCodesCardProps {
  /** Optional hook into a host page's status banner. The card always shows its
   *  own inline messages too — an error next to the control that caused it is
   *  more useful than a banner three sections away. */
  onStatus?: (status: 'success' | 'error', message: string) => void
}

/** The plaintext code, held in memory for exactly one render pass. */
interface IssuedCode {
  code: string
  ttlHours: number
  expiresAt: string | null
}

const MAX_LABEL_CHARS = 120

/**
 * Status tones.
 *
 * Only `live` gets the accent — a working code is the definition of the "live"
 * signal this palette reserves orange for (globals.css). Revoked and expired
 * are settled, unremarkable states and read as such; neither is an error, so
 * neither is red.
 */
const STATUS_TONE: Record<AccessCodeStatus, 'accent' | 'muted' | 'none'> = {
  live: 'accent',
  expired: 'muted',
  revoked: 'none',
  invalid: 'none',
}

/**
 * Demo access codes — issue, revoke, and read what each one was used for.
 *
 * The plaintext code exists in exactly one place: the response to the create
 * request, rendered once. It is never stored client-side beyond that render,
 * never written to the URL, and cannot be recovered afterwards — the server
 * keeps only a SHA-256 hash. That constraint drives the shape of this
 * component: the "here is your code" panel is a deliberate, dismissible
 * checkpoint rather than a toast that can be missed.
 */
export function AccessCodesCard({ onStatus }: AccessCodesCardProps) {
  const labelInputId = useId()

  const [codes, setCodes] = useState<AccessCodeSummary[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [liveLimit, setLiveLimit] = useState<number | null>(null)
  /**
   * How many codes are live, AS COUNTED BY THE SERVER — null until it says.
   *
   * Never derived from `codes`. That list is one capped page (MAX_LISTED in
   * app/api/access-codes/route.ts), so counting it client-side under-reports
   * for any owner past the cap: the counter would read "12 of 25 live" right up
   * to the moment creating one returned a 409 saying there were already 25. A
   * number the client cannot know is worse than no number, so when the server
   * does not send one we state the limit and assert no count at all.
   */
  const [liveCount, setLiveCount] = useState<number | null>(null)
  const [ttlHours, setTtlHours] = useState(72)

  const [label, setLabel] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [issued, setIssued] = useState<IssuedCode | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const issuedPanelRef = useRef<HTMLDivElement>(null)

  const [revokeTarget, setRevokeTarget] = useState<AccessCodeSummary | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // Revoking removes the button that opened the dialog, so the focus Radix
  // would normally restore no longer exists and lands on <body>. These two let
  // us hand focus to the row's surviving control instead — see the
  // onCloseAutoFocus handler below.
  const activityButtons = useRef(new Map<string, HTMLButtonElement>())
  const lastRevokedId = useRef<string | null>(null)

  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadCodes = useCallback(async () => {
    setListState('loading')
    setListError(null)
    try {
      const response = await fetch('/api/access-codes')
      const payload = (await response.json().catch(() => ({}))) as {
        codes?: AccessCodeSummary[]
        liveLimit?: number
        /** Server-counted live codes. Absent on older deployments — see below. */
        liveCount?: number
        ttlHours?: number
        error?: string
      }
      if (!response.ok) {
        // The codes already on screen are NOT cleared. A failed refresh means we
        // could not get a newer answer, not that the previous one stopped being
        // true — and the list is where the owner's only kill switch lives, so
        // replacing twenty codes with an error panel takes away Revoke exactly
        // when something is already going wrong. The render below keeps the list
        // and puts this message above it.
        setListError(payload.error || "Couldn't load your access codes.")
        setListState('error')
        return
      }
      setCodes(payload.codes ?? [])
      if (typeof payload.liveLimit === 'number') setLiveLimit(payload.liveLimit)
      // Only ever the server's number. `undefined` leaves it null, and the
      // counter then says what it can prove instead of guessing.
      setLiveCount(typeof payload.liveCount === 'number' ? payload.liveCount : null)
      if (typeof payload.ttlHours === 'number') setTtlHours(payload.ttlHours)
      setListState('ready')
    } catch {
      setListError("Couldn't reach the server. Check your connection and try again.")
      setListState('error')
    }
  }, [])

  useEffect(() => {
    loadCodes()
  }, [loadCodes])

  // Move focus to the freshly issued code. It is the only time this value will
  // ever be on screen, so a keyboard or screen-reader user must land on it
  // rather than discover it by chance three tab stops later.
  useEffect(() => {
    if (issued) issuedPanelRef.current?.focus()
  }, [issued])

  async function createCode(event: React.FormEvent) {
    event.preventDefault()
    if (isCreating) return

    setIsCreating(true)
    setCreateError(null)
    setCopyState('idle')

    try {
      const response = await fetch('/api/access-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string
        ttlHours?: number
        summary?: AccessCodeSummary
        error?: string
      }

      if (!response.ok || !payload.code) {
        const message = payload.error || "Couldn't issue a code right now. Try again."
        setCreateError(message)
        onStatus?.('error', message)
        return
      }

      setIssued({
        code: payload.code,
        ttlHours: payload.ttlHours ?? ttlHours,
        expiresAt: payload.summary?.expiresAt ?? null,
      })
      setLabel('')
      if (payload.summary) setCodes((current) => [payload.summary!, ...current])
      // An exact delta on an exact number: a code that was just issued is live
      // by construction. Only ever applied to a count the SERVER gave us, so
      // this keeps the counter true between fetches rather than inventing one.
      setLiveCount((current) => (current === null ? null : current + 1))
      onStatus?.('success', 'Demo code created — copy it now, it will not be shown again.')
    } catch {
      const message = "Couldn't reach the server. Check your connection and try again."
      setCreateError(message)
      onStatus?.('error', message)
    } finally {
      setIsCreating(false)
    }
  }

  async function copyIssuedCode() {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.code)
      setCopyState('copied')
    } catch {
      // Clipboard access can be refused (insecure context, permissions). Say so
      // instead of pretending it worked — the code is unrecoverable if lost.
      setCopyState('failed')
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget || isRevoking) return

    setIsRevoking(true)
    setRevokeError(null)
    try {
      const response = await fetch(`/api/access-codes/${revokeTarget.id}/revoke`, { method: 'POST' })
      const payload = (await response.json().catch(() => ({}))) as {
        code?: AccessCodeSummary
        error?: string
      }

      if (!response.ok || !payload.code) {
        const message = payload.error || "Couldn't revoke that code. Try again."
        setRevokeError(message)
        return
      }

      const updated = payload.code
      setCodes((current) => current.map((code) => (code.id === updated.id ? updated : code)))
      // Same exact-delta rule as create. Only a code the server called `live`
      // was counted in the first place, so only that one comes back out; if it
      // had quietly expired since the last fetch the stored count was already
      // one too high, and the decrement corrects that too. Clamped because a
      // count that has gone negative is a bug we should not also render.
      if (revokeTarget.status === 'live') {
        setLiveCount((current) => (current === null ? null : Math.max(0, current - 1)))
      }
      lastRevokedId.current = updated.id
      setRevokeTarget(null)
      onStatus?.('success', 'Access code revoked.')
    } catch {
      setRevokeError("Couldn't reach the server. Check your connection and try again.")
    } finally {
      setIsRevoking(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Demo access codes</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Hand someone a code and they sign into their own demo workspace — seeded with its own jobs,
          resume and matches, never your account. Each code stops working {ttlHours} hours after you
          create it, and everything done with it shows up here.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Create                                                            */}
      {/* ---------------------------------------------------------------- */}
      <form onSubmit={createCode} className="rounded-card border bg-card p-4">
        <label htmlFor={labelInputId} className="text-body font-medium text-foreground">
          Label <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <p className="mt-0.5 text-caption text-muted-foreground">
          Only you see this. It is how you tell one code from another later.
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id={labelInputId}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={MAX_LABEL_CHARS}
            placeholder="Acme walkthrough, Thursday"
            className="sm:flex-1"
            disabled={isCreating}
          />
          <Button type="submit" disabled={isCreating} className="shrink-0">
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
            Create demo code
          </Button>
        </div>

        {liveLimit !== null && (
          <p className="mt-2 text-caption text-muted-foreground">
            {liveCount !== null
              ? `${liveCount} of ${liveLimit} codes live.`
              : // No server count available: state the rule, claim no number.
                // The cap is still enforced — a create past it comes back as a
                // 409 whose message names the limit, shown inline below.
                `Up to ${liveLimit} codes can be live at once.`}
          </p>
        )}

        {createError && (
          <p className="mt-2 flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {createError}
          </p>
        )}
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* The code, shown exactly once                                      */}
      {/* ---------------------------------------------------------------- */}
      {issued && (
        <div
          ref={issuedPanelRef}
          tabIndex={-1}
          role="region"
          aria-label="Your new demo access code"
          className="rounded-card border border-accent/40 bg-accent-tint p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <p className="text-body font-medium text-accent-deep">
            Copy this code now — it will not be shown again.
          </p>
          <p className="mt-1 text-caption text-muted-foreground">
            We only ever store a hash of it, so there is no way to look it up later. It expires in{' '}
            {issued.ttlHours} hours
            {issued.expiresAt ? `, on ${formatMoment(issued.expiresAt)}` : ''}.
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code
              aria-hidden
              className="select-all rounded-control bg-raised px-3 py-2 font-readout text-readout tracking-wider text-foreground shadow-raised"
            >
              {issued.code}
            </code>
            {/* The alphabet was chosen so this code survives being read aloud
                (lib/access/codes.ts). Spelling it out for a screen reader is
                the same courtesy: "P7QK" pronounced as a word is unusable, and
                there is no second chance to hear it. */}
            <span className="sr-only">Your access code is {spellOut(issued.code)}</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={copyIssuedCode}>
                {copyState === 'copied' ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                {copyState === 'copied' ? 'Copied' : 'Copy code'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setIssued(null)
                  setCopyState('idle')
                }}
              >
                Done
              </Button>
            </div>
          </div>

          {copyState === 'failed' && (
            <p className="mt-2 text-caption text-red-700 dark:text-red-300">
              Your browser refused clipboard access — select the code above and copy it manually
              before dismissing this.
            </p>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The list                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-label uppercase text-muted-foreground">Your codes</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadCodes}
            disabled={listState === 'loading'}
          >
            <RotateCw
              className={cn('h-3.5 w-3.5', listState === 'loading' && 'animate-spin')}
              aria-hidden
            />
            Refresh
          </Button>
        </div>

        {/* The three states below are about whether there is anything to SHOW,
            not about whether the last request succeeded. Once codes have been
            fetched they stay rendered through a refresh and through a refresh
            that fails — a load failure becomes the banner above the list rather
            than something that replaces it. */}
        {listState === 'loading' && codes.length === 0 ? (
          // The skeletons are decoration; the sentence is what a screen reader
          // needs. A labelled list of three empty items announces as noise.
          <div role="status" aria-live="polite">
            <span className="sr-only">Loading your access codes…</span>
            <ul aria-hidden className="space-y-2">
              {[0, 1, 2].map((i) => (
                <li key={i} className="skeleton h-[86px] rounded-card" />
              ))}
            </ul>
          </div>
        ) : listState === 'error' && codes.length === 0 ? (
          <EmptyState
            icon={AlertCircle}
            headingLevel="h4"
            title="Couldn't load your codes"
            body={listError ?? undefined}
            action={
              <Button size="sm" onClick={loadCodes}>
                Retry
              </Button>
            }
          />
        ) : codes.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            headingLevel="h4"
            title="No demo codes yet"
            body={`Create one and hand it over. It works for ${ttlHours} hours, in a workspace of its own.`}
          />
        ) : (
          <>
            {listState === 'error' && (
              <div
                role="alert"
                className="mb-2 flex items-start gap-2 rounded-control bg-red-50 p-3 text-caption text-red-700 dark:bg-red-500/10 dark:text-red-300"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p>
                    {listError} These are the codes from the last successful load — revoking still
                    works.
                  </p>
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={loadCodes}>
                    Try again
                  </Button>
                </div>
              </div>
            )}
            <ul className="space-y-2">
              {codes.map((code) => (
                <CodeRow
                  key={code.id}
                  code={code}
                  isExpanded={expandedId === code.id}
                  registerActivityButton={(node) => {
                    if (node) activityButtons.current.set(code.id, node)
                    else activityButtons.current.delete(code.id)
                  }}
                  onToggleActivity={() =>
                    setExpandedId((current) => (current === code.id ? null : code.id))
                  }
                  onRevoke={() => {
                    setRevokeError(null)
                    setRevokeTarget(code)
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Revoke confirmation                                               */}
      {/* ---------------------------------------------------------------- */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isRevoking) {
            setRevokeTarget(null)
            setRevokeError(null)
          }
        }}
      >
        <DialogContent
          className="max-w-md"
          onCloseAutoFocus={(event) => {
            const id = lastRevokedId.current
            lastRevokedId.current = null
            const fallback = id ? activityButtons.current.get(id) : undefined
            if (!fallback) return
            event.preventDefault()
            fallback.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Revoke this code?</DialogTitle>
            <DialogDescription>
              {revokeTarget ? describeRevoke(revokeTarget) : 'This code stops working immediately.'}
            </DialogDescription>
          </DialogHeader>

          {revokeError && (
            <p className="flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {revokeError}
            </p>
          )}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={isRevoking}
            >
              Keep it active
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRevoke} disabled={isRevoking}>
              {isRevoking ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldOff className="h-4 w-4" aria-hidden />
              )}
              Revoke code
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface CodeRowProps {
  code: AccessCodeSummary
  isExpanded: boolean
  /** Lets the card park focus here after the Revoke button disappears. */
  registerActivityButton: (node: HTMLButtonElement | null) => void
  onToggleActivity: () => void
  onRevoke: () => void
}

function CodeRow({
  code,
  isExpanded,
  registerActivityButton,
  onToggleActivity,
  onRevoke,
}: CodeRowProps) {
  const activityId = `access-code-activity-${code.id}`
  const name = describeCode(code)

  return (
    <li className="rounded-card border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-foreground">
              {code.label ?? 'Untitled code'}
            </span>
            <Badge tone={STATUS_TONE[code.status]}>{code.statusLabel}</Badge>
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
            {/* The prefix is all the code we keep in the clear — enough to tell
                two codes apart, useless as a credential. */}
            <span className="font-readout tracking-wider text-foreground">
              {code.prefix || '····'}
              <span className="text-muted-foreground">-····-····</span>
            </span>
            {code.timeRemaining && <span>· {code.timeRemaining}</span>}
            <span>· {redemptionSummary(code)}</span>
            {code.lastUsedAt && <span>· last used {formatMoment(code.lastUsedAt)}</span>}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            ref={registerActivityButton}
            onClick={onToggleActivity}
            aria-expanded={isExpanded}
            aria-controls={activityId}
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-180')}
              aria-hidden
            />
            Activity
          </Button>
          {/* ANYTHING NOT ALREADY REVOKED CAN BE REVOKED.
              Offering this only for 'live' left the one code an owner most
              wants to kill un-killable: 'invalid' means expires_at would not
              parse (see contract.ts), so nothing can say when — or whether —
              that code stops working, and "it looks expired" is not the same
              promise as "it is off". 'expired' is included for the same reason
              in weaker form: that status is a judgement about a timestamp read
              at fetch time, while revocation is an unconditional off switch
              that depends on no clock. This mirrors the server exactly — the
              revoke route updates `.is('revoked_at', null)`, i.e. this same
              set — and re-revoking is a no-op there, so the two can never
              disagree about what is killable. */}
          {code.status !== 'revoked' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRevoke}
              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Revoke
              <span className="sr-only"> {name}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Mounted only while expanded, so a list of twenty codes fetches nothing
          until the owner asks about one. */}
      <div id={activityId} hidden={!isExpanded}>
        {isExpanded && <AccessCodeActivity codeId={code.id} codeName={name} className="mt-3" />}
      </div>
    </li>
  )
}

/** How this code is referred to in prose — the label if there is one, else its prefix. */
function describeCode(code: AccessCodeSummary): string {
  return code.label ?? (code.prefix ? `Code ${code.prefix}…` : 'This code')
}

/**
 * What revoking THIS code actually does, in the confirmation dialog.
 *
 * A live code and a code that already looks dead deserve different sentences:
 * "stops working immediately" is the whole story for the first and slightly
 * beside the point for the second, where the owner is really asking "is this
 * definitely off?". Saying so is the difference between a confirmation and a
 * shrug — and for an 'invalid' code (an expiry that will not parse) it is the
 * only honest answer available.
 */
function describeRevoke(code: AccessCodeSummary): string {
  const name = describeCode(code)
  if (code.status === 'live') {
    const remaining = code.timeRemaining ? `, with ${code.timeRemaining}` : ''
    return `${name} stops working immediately${remaining}. Anyone holding it loses access to the demo workspace. The activity already recorded is kept.`
  }
  return `${name} already reads as "${code.statusLabel.toLowerCase()}", but revoking is the only switch that does not depend on a date being readable: it can never be redeemed again, whatever its expiry says. The activity already recorded is kept.`
}

function redemptionSummary(code: AccessCodeSummary): string {
  if (code.redemptionCount === 0) return 'never redeemed'
  if (code.redemptionCount === 1) return 'redeemed once'
  return `redeemed ${code.redemptionCount} times`
}

/** "P 7 Q K dash 3 M 9 X dash T C R 2" — a code a screen reader can dictate. */
function spellOut(code: string): string {
  return code
    .split('')
    .map((character) => (character === '-' ? 'dash' : character))
    .join(' ')
}

/** "Aug 3, 2:41 PM" — a date a person can match against a calendar. */
function formatMoment(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'an unknown time'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}
