'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { AlertCircle, KeyRound, Loader2, Lock, Plus, RotateCw, ShieldAlert, Trash2 } from 'lucide-react'
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
import type { ApplyCredentialSummary, EncryptionStatus } from '@/lib/apply/vault'

// `import type` above is load-bearing: lib/apply/vault.ts imports node:crypto,
// so a VALUE import would drag it into the browser bundle and break the build.
// Types are erased at compile time. Same constraint, same reason, as
// components/settings/access-codes-card.tsx's import of the access-code
// contract.

export interface ApplyCredentialsCardProps {
  /** Optional hook into a host page's status banner. The card always shows its own
   *  inline messages too — an error next to the control that caused it is more
   *  useful than a banner three sections away. */
  onStatus?: (status: 'success' | 'error', message: string) => void
}

const MAX_LABEL_CHARS = 120

/**
 * Employer board sign-ins — the ones the user ALREADY HAS.
 *
 * WHAT THIS SURFACE IS AND IS NOT
 *   It stores the sign-in for a board the user already has an account on, so
 *   the apply engine can authenticate as them instead of asking a student to
 *   create an account for each of 200 applications a week. It does not create
 *   accounts anywhere, and it has nothing to do with getting past a site that
 *   has decided to refuse automation — when a board wants a new account or
 *   throws a challenge, the application becomes a prefilled handoff for the
 *   human, which is a fixed product decision and not a gap.
 *
 * THERE IS NO WAY TO READ A SAVED PASSWORD BACK. Not plainly, not masked, not
 * behind a "reveal" button, not by re-typing the current one to unlock it. A
 * password a browser can display is a password anyone holding that session can
 * display, and the whole value of this vault is that the plaintext exists in
 * exactly one place — the server, at the moment it authenticates. So the list
 * below shows which account is stored and when it was last used, and the only
 * two operations are "replace it" and "remove it". If the user cannot remember
 * what they typed, the answer is to save it again; that is a deliberate cost.
 *
 * THE DISCLOSURE IS PART OF THE FEATURE, NOT DECORATION AROUND IT. A person
 * deciding whether to hand a piece of software their password needs the actual
 * trade in front of them: it is encrypted with a key on their own deployment,
 * and anyone holding both that key and the database can read it. Softening
 * that into "we take security seriously" would be the one genuinely dishonest
 * thing this card could do.
 */
export function ApplyCredentialsCard({ onStatus }: ApplyCredentialsCardProps) {
  const hostId = useId()
  const labelId = useId()
  const usernameId = useId()
  const secretId = useId()

  const [credentials, setCredentials] = useState<ApplyCredentialSummary[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
  /**
   * Whether this deployment can encrypt at all — answered by the server, never
   * guessed here. Null until it says, and the form stays disabled until then:
   * an optimistic form would let someone type a password in the seconds before
   * we learn it cannot be stored safely.
   */
  const [encryption, setEncryption] = useState<EncryptionStatus | null>(null)

  const [host, setHost] = useState('')
  const [label, setLabel] = useState('')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [removeTarget, setRemoveTarget] = useState<ApplyCredentialSummary | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setListState('loading')
    setListError(null)
    try {
      const response = await fetch('/api/apply-credentials')
      const payload = (await response.json().catch(() => ({}))) as {
        credentials?: ApplyCredentialSummary[]
        encryption?: EncryptionStatus
        error?: string
      }
      if (!response.ok) {
        // The list already on screen is NOT cleared: a failed refresh means we
        // could not get a newer answer, not that the old one stopped being
        // true — and this list is where the only Remove button lives.
        setListError(payload.error || "Couldn't load your saved sign-ins.")
        setListState('error')
        return
      }
      setCredentials(payload.credentials ?? [])
      if (payload.encryption) setEncryption(payload.encryption)
      setListState('ready')
    } catch {
      setListError("Couldn't reach the server. Check your connection and try again.")
      setListState('error')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Belt and braces on top of clearing the field after each save: if this card
  // unmounts mid-edit — the user switches tab, the page navigates — the typed
  // password does not linger in a retained state object.
  useEffect(() => () => setSecret(''), [])

  const canSave = encryption?.ready === true

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (isSaving || !canSave) return

    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await fetch('/api/apply-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          label: label.trim() || null,
          username,
          // Sent exactly as typed — the server does not trim it either, because
          // a leading space is a legal password character and removing one
          // produces a sign-in that fails for no visible reason.
          secret,
          // `provider` is deliberately not asked for. "Which applicant tracking
          // system is this?" is a question about our implementation, not about
          // the user's account, and the host alone is what resolution matches
          // on anyway.
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        credential?: ApplyCredentialSummary
        error?: string
      }

      if (!response.ok || !payload.credential) {
        const message = payload.error || "Couldn't save that sign-in. Try again."
        setSaveError(message)
        onStatus?.('error', message)
        // The password is deliberately LEFT IN THE FIELD on failure — clearing
        // it would make a retry mean re-typing it, and the most likely failures
        // here (a typo'd address, a momentary server error) are ones the user
        // fixes and immediately resubmits.
        return
      }

      const saved = payload.credential
      setCredentials((current) => {
        const rest = current.filter((row) => row.id !== saved.id)
        return [saved, ...rest]
      })
      setHost('')
      setLabel('')
      setUsername('')
      // First thing to go on success, before any other state settles.
      setSecret('')
      onStatus?.('success', `Saved your sign-in for ${saved.host}.`)
    } catch {
      const message = "Couldn't reach the server. Check your connection and try again."
      setSaveError(message)
      onStatus?.('error', message)
    } finally {
      setIsSaving(false)
    }
  }

  async function confirmRemove() {
    if (!removeTarget || isRemoving) return
    setIsRemoving(true)
    setRemoveError(null)
    try {
      const response = await fetch(`/api/apply-credentials/${removeTarget.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        setRemoveError(payload.error || "Couldn't remove that sign-in. Try again.")
        return
      }
      setCredentials((current) => current.filter((row) => row.id !== removeTarget.id))
      setRemoveTarget(null)
      onStatus?.('success', 'Sign-in removed.')
    } catch {
      setRemoveError("Couldn't reach the server. Check your connection and try again.")
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Employer board sign-ins</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Some boards — Workday especially — will not take an application without an account on that
          specific employer&apos;s site. Save the sign-in you already use there and applications can be
          submitted for you instead of stopping to ask. Boards that need a new account, or that put up
          a challenge, always come back to you as a prefilled draft.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The honest version of the trade                                   */}
      {/* ---------------------------------------------------------------- */}
      <div className="rounded-card border bg-sunken p-4">
        <div className="flex items-start gap-2">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 space-y-2 text-caption text-muted-foreground">
            <p className="text-body font-medium text-foreground">Before you save a password</p>
            <p>
              It is encrypted before it is written down, with a key that lives in this
              deployment&apos;s environment and not in the database — so a copy of the database on its
              own is useless. Anyone who holds <em>both</em> that key and the database can read it.
              That is the real boundary, and it is worth knowing rather than guessing.
            </p>
            <p>
              <span className="font-medium text-foreground">
                Use a job-search account you do not use anywhere else.
              </span>{' '}
              A password reused across your email and your bank is the wrong thing to put here — not
              because this is careless with it, but because the cost of ever being wrong about that is
              your whole life rather than one job board.
            </p>
            <p>
              Saved passwords are never shown again — not here, not masked, not behind a reveal
              button. They are decrypted on the server only at the moment an application is being
              submitted, and you can see below when that last happened.
            </p>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Encryption is not real -> nothing gets typed                       */}
      {/* ---------------------------------------------------------------- */}
      {encryption && !encryption.ready && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-red-200 bg-red-50 p-4 text-caption text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Passwords can&apos;t be saved on this deployment yet</p>
            {/* The server's own words. This is a self-hosted, single-user
                product: the person reading this is the person who can fix it,
                so the message names the variable instead of saying "contact
                your administrator". */}
            <p className="mt-1">{encryption.message}</p>
            <p className="mt-1">
              Everything else keeps working — applications to boards that need a sign-in just come back
              to you as prefilled drafts.
            </p>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Add                                                               */}
      {/* ---------------------------------------------------------------- */}
      <form onSubmit={save} className="rounded-card border bg-card p-4">
        <fieldset disabled={!canSave || isSaving} className="space-y-3">
          <legend className="sr-only">Add an employer board sign-in</legend>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={hostId} className="text-body font-medium text-foreground">
                Board address
              </label>
              <p className="mt-0.5 text-caption text-muted-foreground">
                Paste any URL on the board. Only the site is stored.
              </p>
              <Input
                id={hostId}
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="https://acme.wd5.myworkdayjobs.com"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                className="mt-2"
                required
              />
            </div>

            <div>
              <label htmlFor={labelId} className="text-body font-medium text-foreground">
                Label <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <p className="mt-0.5 text-caption text-muted-foreground">
                How you&apos;ll recognise it. Defaults to the site.
              </p>
              <Input
                id={labelId}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={MAX_LABEL_CHARS}
                placeholder="Acme careers"
                className="mt-2"
              />
            </div>

            <div>
              <label htmlFor={usernameId} className="text-body font-medium text-foreground">
                Username or email
              </label>
              <p className="mt-0.5 text-caption text-muted-foreground">
                The one you sign into that board with.
              </p>
              <Input
                id={usernameId}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="you@example.com"
                className="mt-2"
                required
              />
            </div>

            <div>
              <label htmlFor={secretId} className="text-body font-medium text-foreground">
                Password
              </label>
              <p className="mt-0.5 text-caption text-muted-foreground">
                Encrypted before it is stored. Never shown again.
              </p>
              {/* No show/hide toggle, on purpose — see the component header.
                  autoComplete="new-password" keeps the browser from filling
                  this with a saved credential for THIS app, which is a
                  different account entirely and would be saved to the wrong
                  board without the user noticing. */}
              <Input
                id={secretId}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                className="mt-2"
                required
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit">
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Save sign-in
            </Button>
            {encryption === null && listState === 'loading' && (
              <span className="text-caption text-muted-foreground">Checking encryption…</span>
            )}
          </div>
        </fieldset>

        {saveError && (
          <p className="mt-3 flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {saveError}
          </p>
        )}
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* The list                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-label uppercase text-muted-foreground">Saved sign-ins</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={listState === 'loading'}
          >
            <RotateCw
              className={listState === 'loading' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
              aria-hidden
            />
            Refresh
          </Button>
        </div>

        {listState === 'loading' && credentials.length === 0 ? (
          <div role="status" aria-live="polite">
            <span className="sr-only">Loading your saved sign-ins…</span>
            <ul aria-hidden className="space-y-2">
              {[0, 1].map((i) => (
                <li key={i} className="skeleton h-[72px] rounded-card" />
              ))}
            </ul>
          </div>
        ) : listState === 'error' && credentials.length === 0 ? (
          <EmptyState
            icon={AlertCircle}
            headingLevel="h4"
            title="Couldn't load your sign-ins"
            body={listError ?? undefined}
            action={
              <Button size="sm" onClick={load}>
                Retry
              </Button>
            }
          />
        ) : credentials.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            headingLevel="h4"
            title="No sign-ins saved"
            body="Applications to boards that need an account come back to you as prefilled drafts until you add one."
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
                  <p>{listError} These are the sign-ins from the last successful load.</p>
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={load}>
                    Try again
                  </Button>
                </div>
              </div>
            )}
            <ul className="space-y-2">
              {credentials.map((credential) => (
                <li key={credential.id} className="rounded-card border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-body font-medium text-foreground">
                        {credential.label}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
                        <span className="truncate">{credential.host}</span>
                        <span aria-hidden>·</span>
                        {/* The username is shown; the password is not, and
                            there is no control here that could change that. */}
                        <span className="truncate">{credential.username}</span>
                        <span aria-hidden>·</span>
                        <span>{describeLastUsed(credential.lastUsedAt)}</span>
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRemoveError(null)
                        setRemoveTarget(credential)
                      }}
                      className="shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Remove
                      <span className="sr-only"> {credential.label}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-caption text-muted-foreground">
              To change a password, save the same board and username again — it replaces what is
              stored.
            </p>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Remove confirmation                                               */}
      {/* ---------------------------------------------------------------- */}
      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isRemoving) {
            setRemoveTarget(null)
            setRemoveError(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this sign-in?</DialogTitle>
            <DialogDescription>
              {removeTarget
                ? `${removeTarget.label} (${removeTarget.username}) is deleted from this deployment straight away. Applications to ${removeTarget.host} will come back to you as prefilled drafts instead. Your account on that board is untouched.`
                : 'This sign-in is deleted straight away.'}
            </DialogDescription>
          </DialogHeader>

          {removeError && (
            <p className="flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {removeError}
            </p>
          )}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={isRemoving}
            >
              Keep it
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRemove} disabled={isRemoving}>
              {isRemoving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Remove sign-in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * "Used Aug 3, 2:41 PM" / "Never used".
 *
 * The only visibility the owner has into what their vault is doing, so it is
 * stated plainly rather than as a relative "2 days ago" that hides which day.
 */
function describeLastUsed(iso: string | null): string {
  if (!iso) return 'never used'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'last used at an unknown time'
  return `last used ${date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })}`
}
