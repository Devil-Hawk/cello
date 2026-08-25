'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileEdit,
  Loader2,
  Mail,
  RefreshCw,
  Send,
  ShieldAlert,
  Share2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/ui/panel'
import { createClient } from '@/lib/supabase/client'
import {
  GMAIL_PERMISSION_SCOPES,
  GMAIL_PERMISSION_TIER_META,
  INCREMENTAL_OAUTH_QUERY_PARAMS,
  fetchGrantedGoogleScopes,
  liveScopesCoverTier,
  type GmailPermissionState,
  type GmailPermissionTier,
} from '@/lib/gmail/permissions'

export interface ConnectionsTabProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

type GoogleTier = 'send' | 'monitor'

/**
 * Gmail permission management.
 *
 * What used to be one all-or-nothing "connect Gmail" grant (gmail.readonly,
 * requested at login and on every reconnect) is four independently
 * grantable permissions — see lib/gmail/permissions.ts for the model this
 * renders. A user can turn on "Send approved messages" while leaving
 * mailbox reading off entirely; the two Google-scoped tiers (send, monitor)
 * each request ONLY their own scope via incremental OAuth
 * (`include_granted_scopes`), so granting one never silently grants the
 * other.
 *
 * The Gmail sync card on the dashboard links here when a sync is blocked —
 * either `needsPermission` (monitor isn't turned on) or `needsReauth`
 * (the live token expired and needs a fresh grant).
 */
export function ConnectionsTab({ onStatus }: ConnectionsTabProps) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [permissions, setPermissions] = useState<GmailPermissionState | null>(null)
  const [legacy, setLegacy] = useState<{ hasSyncHistory: boolean; lastSyncedAt: string | null } | null>(null)
  const [provider, setProvider] = useState<string | null>(null)
  const [hasLiveToken, setHasLiveToken] = useState<boolean | null>(null)
  const [liveScopes, setLiveScopes] = useState<string[]>([])
  const [busyTier, setBusyTier] = useState<GmailPermissionTier | null>(null)

  const [shareOpen, setShareOpen] = useState(false)
  const [shareForm, setShareForm] = useState({ subject: '', from: '', body: '' })
  const [shareBusy, setShareBusy] = useState(false)
  const [shareResult, setShareResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/gmail/permissions')
        const data = await res.json()
        if (!cancelled && res.ok) {
          setPermissions(data.permissions)
          setLegacy(data.legacy)
        }
      } catch {
        // Leave permissions null — every card below just renders as "off",
        // which is the safe default, not a crash.
      }

      const { data: { session } } = await supabase.auth.getSession()
      const { data: { user } } = await supabase.auth.getUser()
      if (cancelled) return
      setProvider((user?.app_metadata?.provider as string | undefined) ?? null)
      const liveToken = session?.provider_token ?? null
      setHasLiveToken(Boolean(liveToken))

      if (liveToken) {
        const scopes = await fetchGrantedGoogleScopes(liveToken)
        if (!cancelled) setLiveScopes(scopes)
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [supabase])

  async function persistTier(tier: GmailPermissionTier, enabled: boolean, successMessage: string) {
    setBusyTier(tier)
    try {
      const res = await fetch('/api/gmail/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, enabled }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to update this permission')
      setPermissions(data.permissions)
      onStatus('success', successMessage)
    } catch (err) {
      onStatus('error', err instanceof Error ? err.message : 'Failed to update this permission')
    } finally {
      setBusyTier(null)
    }
  }

  async function grantGoogleTier(tier: GoogleTier) {
    setBusyTier(tier)
    const scope = GMAIL_PERMISSION_SCOPES[tier]
    if (!scope) return
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/settings?tab=connections')}`,
          // Exactly the one new scope — narrowest request. `include_granted_scopes`
          // asks Google to fold in every scope this user already granted
          // separately, so this never drops an existing send/monitor grant.
          scopes: scope,
          queryParams: INCREMENTAL_OAUTH_QUERY_PARAMS,
        },
      })
      if (error) {
        onStatus('error', error.message)
        setBusyTier(null)
      }
      // On success the browser navigates to Google; nothing else to do here.
    } catch (err) {
      onStatus('error', err instanceof Error ? err.message : 'Could not start Google sign-in')
      setBusyTier(null)
    }
  }

  async function submitShare() {
    setShareBusy(true)
    setShareResult(null)
    try {
      const res = await fetch('/api/gmail/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shareForm),
      })
      const data = await res.json()
      if (!res.ok) {
        setShareResult({ ok: false, message: data.error || 'Could not process this thread' })
        return
      }
      if (!data.matched) {
        setShareResult({ ok: false, message: data.reason || 'Nothing matched a tracked application' })
        return
      }
      setShareResult({
        ok: true,
        message: data.alreadyProcessed
          ? `Already processed — no change to ${data.company}.`
          : `${data.created ? 'Created' : 'Updated'} your application at ${data.company} (stage: ${data.stage}).`,
      })
      setShareForm({ subject: '', from: '', body: '' })
    } catch (err) {
      setShareResult({ ok: false, message: err instanceof Error ? err.message : 'Could not process this thread' })
    } finally {
      setShareBusy(false)
    }
  }

  const isGoogle = provider === 'google'
  const state = permissions
  const migratedMonitor = state?.monitor.migratedFrom === 'legacy_readonly_grant' && state.monitor.enabled

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-display text-section text-foreground">Connections</h2>
        <p className="text-caption text-muted-foreground">
          Gmail access is four separate permissions, not one. Turn on exactly what you
          want — sending doesn&apos;t require letting Cello read your inbox.
        </p>
      </div>

      {migratedMonitor && legacy?.hasSyncHistory && (
        <Panel tone="accent" divider="left" className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-deep" />
          <p className="text-caption text-foreground">
            <span className="font-medium">Carried over from before:</span> your account already
            had Gmail sync running, so &quot;Monitor mailbox&quot; below stayed on — nothing
            broke. Turn it off anytime; it&apos;s just like any other permission now.
          </p>
        </Panel>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading permissions…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Tier 1 — Prepare messages: no Google access at all. */}
          <PermissionCard
            icon={<FileEdit className="h-5 w-5 text-muted-foreground" />}
            meta={GMAIL_PERMISSION_TIER_META.prepare}
            status={<Badge tone="neutral">Always available</Badge>}
          />

          {/* Tier 2 — Send approved messages: gmail.send only. */}
          <PermissionCard
            icon={<Send className="h-5 w-5 text-muted-foreground" />}
            meta={GMAIL_PERMISSION_TIER_META.send}
            status={<GrantStatus enabled={state?.send.enabled ?? false} />}
            action={
              <GoogleTierAction
                tier="send"
                enabled={state?.send.enabled ?? false}
                busy={busyTier === 'send'}
                liveTokenCoversTier={liveScopesCoverTier(liveScopes, 'send')}
                isGoogle={isGoogle}
                onGrant={() => grantGoogleTier('send')}
                onConfirmLive={() => persistTier('send', true, 'Send approved messages: turned on.')}
                onRevoke={() => persistTier('send', false, 'Send approved messages: turned off.')}
              />
            }
          />

          {/* Tier 3 — Read selected shared threads: no Google scope, paste-in only. */}
          <PermissionCard
            icon={<Share2 className="h-5 w-5 text-muted-foreground" />}
            meta={GMAIL_PERMISSION_TIER_META.readShared}
            status={<GrantStatus enabled={state?.readShared.enabled ?? false} />}
            action={
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={busyTier === 'readShared'}
                onClick={() =>
                  persistTier(
                    'readShared',
                    !(state?.readShared.enabled ?? false),
                    state?.readShared.enabled ? 'Read selected shared threads: turned off.' : 'Read selected shared threads: turned on.'
                  )
                }
              >
                {busyTier === 'readShared' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {state?.readShared.enabled ? 'Turn off' : 'Turn on'}
              </Button>
            }
          >
            {state?.readShared.enabled && (
              <div className="mt-3 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setShareOpen((v) => !v)}
                  className="flex items-center gap-1.5 text-caption font-medium text-accent-deep"
                >
                  {shareOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  Paste a thread
                </button>
                {shareOpen && (
                  <div className="mt-3 space-y-2.5">
                    <Input
                      placeholder="Subject"
                      value={shareForm.subject}
                      onChange={(e) => setShareForm((f) => ({ ...f, subject: e.target.value }))}
                      className="h-9"
                    />
                    <Input
                      placeholder="From (e.g. recruiter@acme.com)"
                      value={shareForm.from}
                      onChange={(e) => setShareForm((f) => ({ ...f, from: e.target.value }))}
                      className="h-9"
                    />
                    <Textarea
                      placeholder="Paste the email body here"
                      value={shareForm.body}
                      onChange={(e) => setShareForm((f) => ({ ...f, body: e.target.value }))}
                      className="min-h-[100px]"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={shareBusy || !shareForm.subject || !shareForm.from || !shareForm.body}
                        onClick={submitShare}
                      >
                        {shareBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        Check against my applications
                      </Button>
                    </div>
                    {shareResult && (
                      <p className={`text-caption ${shareResult.ok ? 'text-success' : 'text-muted-foreground'}`}>
                        {shareResult.message}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </PermissionCard>

          {/* Tier 4 — Monitor mailbox: gmail.readonly, ADVANCED. */}
          <PermissionCard
            icon={<Mail className="h-5 w-5 text-muted-foreground" />}
            meta={GMAIL_PERMISSION_TIER_META.monitor}
            status={<GrantStatus enabled={state?.monitor.enabled ?? false} />}
            advanced
            action={
              <GoogleTierAction
                tier="monitor"
                enabled={state?.monitor.enabled ?? false}
                busy={busyTier === 'monitor'}
                liveTokenCoversTier={liveScopesCoverTier(liveScopes, 'monitor')}
                isGoogle={isGoogle}
                onGrant={() => grantGoogleTier('monitor')}
                onConfirmLive={() => persistTier('monitor', true, 'Monitor mailbox: turned on.')}
                onRevoke={() => persistTier('monitor', false, 'Monitor mailbox: turned off.')}
              />
            }
          >
            {legacy?.lastSyncedAt && (
              <p className="mt-2 text-caption text-muted-foreground">
                Last sync: {new Date(legacy.lastSyncedAt).toLocaleString()}
              </p>
            )}
          </PermissionCard>
        </div>
      )}

      <Panel tone="sunken" className="space-y-1.5">
        <p className="text-caption text-muted-foreground">
          Turning a permission off in Cello stops Cello from using it — Google may still
          remember the consent until you revoke it directly.{' '}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-accent-deep underline"
          >
            Manage in your Google Account <ExternalLink className="h-3 w-3" />
          </a>
        </p>
        {hasLiveToken === false && isGoogle && (
          <p className="text-caption text-muted-foreground">
            Google access tokens are short-lived. If a send or sync fails with
            &quot;needs reconnecting&quot;, use the buttons above to grant that permission again —
            it&apos;s the same one-click flow, it just needs to run periodically.
          </p>
        )}
      </Panel>
    </div>
  )
}

function GrantStatus({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1 text-caption text-success">
      <CheckCircle className="h-3.5 w-3.5" /> On
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
      <AlertCircle className="h-3.5 w-3.5" /> Off
    </span>
  )
}

function GoogleTierAction({
  tier,
  enabled,
  busy,
  liveTokenCoversTier,
  isGoogle,
  onGrant,
  onConfirmLive,
  onRevoke,
}: {
  tier: GoogleTier
  enabled: boolean
  busy: boolean
  /** True when the CURRENT live Google token already carries this scope (per Google's tokeninfo), independent of what Cello has stored. */
  liveTokenCoversTier: boolean
  isGoogle: boolean
  onGrant: () => void
  onConfirmLive: () => void
  onRevoke: () => void
}) {
  if (enabled && !liveTokenCoversTier) {
    // Cello's permission record says this is on, but the LIVE Google token
    // doesn't carry the scope right now — the normal state for a returning
    // user, since Supabase only keeps `provider_token` around right after
    // the OAuth exchange, not across ordinary session refreshes. Reconnect
    // (same one-click grant, since Cello already has consent-of-record) is
    // the primary action; turning the permission off entirely stays
    // reachable but secondary.
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-8" disabled={busy} onClick={onGrant}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Reconnect
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" disabled={busy} onClick={onRevoke}>
          Turn off
        </Button>
      </div>
    )
  }

  if (enabled) {
    return (
      <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onRevoke}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Turn off
      </Button>
    )
  }

  // Google's own tokeninfo already shows this scope on the live session
  // token (e.g. granted just now, before the redirect back landed on this
  // tab) — confirm rather than sending the user through consent again.
  if (liveTokenCoversTier) {
    return (
      <Button size="sm" className="h-8" disabled={busy} onClick={onConfirmLive}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
        Confirm — Google shows this already granted
      </Button>
    )
  }

  return (
    <Button size="sm" className="h-8" disabled={busy} onClick={onGrant}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {isGoogle ? 'Grant with Google' : 'Connect Google'}
    </Button>
  )
}

function PermissionCard({
  icon,
  meta,
  status,
  action,
  advanced,
  children,
}: {
  icon: React.ReactNode
  meta: { label: string; description: string; canSee: string[]; cannotSee: string[]; selfHostWarning: string | null }
  status: React.ReactNode
  action?: React.ReactNode
  advanced?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-card border bg-card p-5">
      <div className="flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border bg-sunken">
          {icon}
        </span>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-foreground">{meta.label}</span>
            {advanced && (
              <Badge tone="warn" className="inline-flex items-center gap-1">
                <ShieldAlert className="h-3 w-3" /> Advanced
              </Badge>
            )}
            {status}
          </div>

          <p className="text-caption text-muted-foreground">{meta.description}</p>

          <div className="grid gap-2 sm:grid-cols-2">
            <ul className="space-y-1">
              {meta.canSee.map((line, i) => (
                <li key={i} className="flex gap-1.5 text-caption text-foreground">
                  <span aria-hidden className="text-success">✓</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <ul className="space-y-1">
              {meta.cannotSee.map((line, i) => (
                <li key={i} className="flex gap-1.5 text-caption text-muted-foreground">
                  <span aria-hidden>✕</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {meta.selfHostWarning && (
            <Panel tone="warn" divider="none" className="flex items-start gap-2 rounded-control">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
              <p className="text-caption text-amber-900 dark:text-amber-200">{meta.selfHostWarning}</p>
            </Panel>
          )}

          {action && <div className="flex flex-wrap gap-2 pt-1">{action}</div>}

          {children}
        </div>
      </div>
    </div>
  )
}
