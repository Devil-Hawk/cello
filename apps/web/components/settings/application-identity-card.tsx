'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, Info, Loader2, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Panel, type PanelTone } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { looksLikeEmail } from '@/lib/contacts/parse-csv'
import {
  EMAIL_VERIFICATION_AVAILABLE,
  type ApplicationIdentity,
  type IdentityNoticeSeverity,
} from '@/lib/apply/identity'

// Editor for profiles.preferences.applicationIdentity — the name, address and
// links that go ON an application.
//
// The one thing this card must never let happen is a user who does not know
// which address employers will reply to. So the resolved address is the first
// thing on the card, it updates live as they type (labelled "after you save"
// while the edit is unsaved, so it is never a claim about the current state),
// and an address that differs from the account address cannot be saved until
// they have said out loud that they can receive mail there.
//
// The server enforces that same gate independently — see
// lib/apply/identity.ts#validateApplicationIdentityUpdate. The checkbox here is
// the humane version of it, not the boundary.

export interface ApplicationIdentityCardProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

interface FormState {
  email: string
  fullName: string
  phone: string
  location: string
  linkedin: string
  website: string
}

const EMPTY_FORM: FormState = { email: '', fullName: '', phone: '', location: '', linkedin: '', website: '' }

function formFrom(identity: ApplicationIdentity): FormState {
  return {
    email: identity.settings.email ?? '',
    fullName: identity.settings.fullName ?? '',
    phone: identity.settings.phone ?? '',
    location: identity.settings.location ?? '',
    linkedin: identity.settings.linkedin ?? '',
    website: identity.settings.website ?? '',
  }
}

const NOTICE_TONE: Record<IdentityNoticeSeverity, PanelTone> = {
  error: 'bad',
  warning: 'warn',
  info: 'sunken',
}

/** One labelled input with the sentence that says what the field is actually used for. */
function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  invalid = false,
  children,
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  autoComplete?: string
  invalid?: boolean
  children?: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="text-body font-medium text-foreground">
        {label}
      </label>
      <p className="mt-0.5 text-caption text-muted-foreground">{hint}</p>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        className={cn('mt-1.5', invalid && 'border-destructive focus-visible:ring-destructive')}
      />
      {children}
    </div>
  )
}

export function ApplicationIdentityCard({ onStatus }: ApplicationIdentityCardProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [identity, setIdentity] = useState<ApplicationIdentity | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saved, setSaved] = useState<FormState>(EMPTY_FORM)
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch('/api/settings/application-identity')
        const result = await response.json()
        if (cancelled) return
        if (!response.ok || result.error) {
          setLoadState('error')
          return
        }
        setIdentity(result.identity)
        setForm(formFrom(result.identity))
        setSaved(formFrom(result.identity))
        setLoadState('ready')
      } catch {
        if (!cancelled) setLoadState('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  if (loadState === 'loading') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (loadState === 'error' || !identity) {
    return (
      <div className="space-y-2">
        <h2 className="font-display text-section text-foreground">Application identity</h2>
        <p className="text-caption text-muted-foreground">
          Couldn&apos;t load your application identity. Check your connection and reload — until it
          loads, applications keep using whatever is already saved.
        </p>
      </div>
    )
  }

  const accountEmail = identity.accountEmail
  const typedEmail = form.email.trim()
  const emailInvalid = typedEmail !== '' && !looksLikeEmail(typedEmail)
  const differsFromAccount =
    typedEmail !== '' && typedEmail.toLowerCase() !== accountEmail.toLowerCase()
  const alreadyConfirmed =
    (identity.settings.confirmedEmail ?? '').toLowerCase() === typedEmail.toLowerCase() &&
    typedEmail !== ''
  const mustConfirm = differsFromAccount && !alreadyConfirmed && !emailInvalid
  const isDirty = JSON.stringify(form) !== JSON.stringify(saved)

  // What the resolved address WILL be once this form is saved — the same
  // precedence resolveApplicationIdentity() applies server-side, mirrored here
  // so the consequence of an edit is visible before it is committed.
  const pendingEmail = emailInvalid
    ? accountEmail // an unusable address is never applied with, so never previewed
    : mustConfirm && !confirmChecked
      ? accountEmail || typedEmail // unconfirmed loses to the account address — unless there isn't one
      : typedEmail || accountEmail
  const pendingIsSeparate =
    pendingEmail !== '' && pendingEmail.toLowerCase() !== accountEmail.toLowerCase()

  async function save() {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings/application-identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, confirm: confirmChecked }),
      })
      const result = await response.json()
      if (!response.ok || result.error) {
        onStatus('error', result.error || 'Failed to save application identity')
        return
      }
      setIdentity(result.identity)
      setForm(formFrom(result.identity))
      setSaved(formFrom(result.identity))
      setConfirmChecked(false)
      onStatus(
        'success',
        result.identity.usesSeparateEmail
          ? `Saved — employers will reply to ${result.identity.email}`
          : 'Application identity saved'
      )
    } catch {
      onStatus('error', 'Failed to save application identity')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Application identity</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          What goes <em>on</em> the applications Cello prepares and submits. This is separate from
          your account on purpose — plenty of people apply from a dedicated address so recruiter
          mail stays out of their personal inbox, or because the address they signed up with is a
          university one that expires. Signing in, billing and Cello&apos;s own alerts always keep
          using your account address, {accountEmail || 'which is not set'}. Work authorisation,
          visa, demographic and salary questions are never auto-answered — those always come back to
          you.
        </p>
      </div>

      {/* The one fact that must never be a surprise. Panel, not a bordered box:
          this card already lives inside the settings Card, and a surface must
          not contain a surface (see components/ui/panel.tsx). */}
      <Panel tone={pendingIsSeparate ? 'accent' : 'sunken'} divider="none">
        <div className="flex items-start gap-3">
          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-caption text-muted-foreground">
              {isDirty ? 'After you save, employers will reply to' : 'Employers reply to'}
            </p>
            <p className="mt-0.5 break-all text-body font-medium text-foreground">
              {pendingEmail || 'no address — an employer would have no way to answer'}
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              {!accountEmail
                ? 'Your account has no address of its own, so this is the only way an employer could reach you.'
                : pendingIsSeparate
                  ? 'Your account address is untouched and still signs you in.'
                  : 'This is your account address. Set one below to apply from somewhere else.'}
            </p>
          </div>
        </div>
      </Panel>

      {identity.notices.length > 0 && (
        <div className="space-y-2">
          {identity.notices.map((notice) => (
            <Panel key={notice.code} tone={NOTICE_TONE[notice.severity]} divider="left">
              <div className="flex items-start gap-2">
                {notice.severity === 'info' ? (
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <p className="text-caption text-foreground">{notice.message}</p>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <div className="space-y-5">
        <Field
          id="application-email"
          label="Application email"
          hint="Goes in the email field of every application, and it is where every interview reply lands. Leave blank to apply with your account address."
          value={form.email}
          onChange={(v) => set('email', v)}
          placeholder={accountEmail || 'you@example.com'}
          type="email"
          autoComplete="email"
          invalid={emailInvalid}
        >
          {emailInvalid && (
            <p className="mt-1.5 text-caption text-destructive">
              That isn&apos;t a usable address. A typo here doesn&apos;t bounce — the reply just
              never arrives.
            </p>
          )}
          {mustConfirm && !emailInvalid && (
            <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-control border border-border bg-sunken/60 px-3 py-2.5">
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--accent))]"
              />
              <span className="text-caption text-foreground">
                I can receive mail at <span className="font-medium">{typedEmail}</span>. Send every
                interview reply there instead of {accountEmail || 'my account address'}.
                {!EMAIL_VERIFICATION_AVAILABLE && (
                  <span className="mt-1 block text-muted-foreground">
                    Cello can&apos;t verify this for you — nothing here sends a test message and
                    waits for it to come back. Until you confirm, applications keep going out from
                    your account address.
                  </span>
                )}
              </span>
            </label>
          )}
          {alreadyConfirmed && identity.settings.confirmedAt && (
            <p className="mt-1.5 text-caption text-muted-foreground">
              Confirmed by you on{' '}
              {new Date(identity.settings.confirmedAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
              . Confirmed, not verified — Cello never sent anything to it.
            </p>
          )}
        </Field>

        <Field
          id="application-full-name"
          label="Display name"
          hint="The name on the application. Cello splits it into the first/last name fields the board asks for. Blank = the name on your profile."
          value={form.fullName}
          onChange={(v) => set('fullName', v)}
          placeholder={identity.fullName || 'Your name'}
          autoComplete="name"
        />

        <Field
          id="application-phone"
          label="Phone"
          hint="Filled into the phone field when a board has one. Written down exactly as you type it — no reformatting."
          value={form.phone}
          onChange={(v) => set('phone', v)}
          placeholder="+1 555 0100"
          type="tel"
          autoComplete="tel"
        />

        <Field
          id="application-location"
          label="Location"
          hint="Your current city or region, for the location field. Not used for job filtering — that lives in Job targeting."
          value={form.location}
          onChange={(v) => set('location', v)}
          placeholder="Seattle, WA"
        />

        <Field
          id="application-linkedin"
          label="LinkedIn URL"
          hint="Goes in the LinkedIn field. If you leave off https:// Cello adds it, because several boards render a scheme-less link as a dead one."
          value={form.linkedin}
          onChange={(v) => set('linkedin', v)}
          placeholder="linkedin.com/in/you"
          type="url"
        />

        <Field
          id="application-website"
          label="Personal site"
          hint="Portfolio or website field. Same https:// handling as LinkedIn."
          value={form.website}
          onChange={(v) => set('website', v)}
          placeholder="you.dev"
          type="url"
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={save}
          disabled={isSaving || !isDirty || emailInvalid || (mustConfirm && !confirmChecked)}
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save application identity
        </Button>
        {isDirty && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setForm(saved)
              setConfirmChecked(false)
            }}
            disabled={isSaving}
          >
            Discard changes
          </Button>
        )}
      </div>
    </div>
  )
}
