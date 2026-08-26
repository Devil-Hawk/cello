'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
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

export interface TokensTabProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

interface ApiToken {
  id: string
  name: string
  scopes: string[]
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

/** The plaintext token, held in memory for exactly one render pass — see
 *  lib/access/tokens.ts createToken. */
interface IssuedToken {
  token: string
  name: string
}

const MAX_NAME_CHARS = 80

function parseScopes(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
}

function describeExpiry(token: ApiToken): string {
  if (token.revokedAt) return 'Revoked'
  if (!token.expiresAt) return 'Never expires'
  const ms = new Date(token.expiresAt).getTime()
  if (!Number.isFinite(ms)) return 'Unknown expiry'
  return ms <= Date.now() ? 'Expired' : `Expires ${new Date(token.expiresAt).toLocaleDateString()}`
}

/**
 * Personal access tokens — the bearer credential MCP clients and A2A callers
 * present instead of a cookie session (lib/access/tokens.ts validateToken).
 * The plaintext exists in exactly one place: the response to a create
 * request, rendered once. It is never stored client-side beyond that render
 * and cannot be recovered afterwards — the server keeps only a SHA-256 hash.
 */
export function TokensTab({ onStatus }: TokensTabProps) {
  const nameInputId = useId()
  const scopesInputId = useId()

  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [scopesText, setScopesText] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [issued, setIssued] = useState<IssuedToken | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const issuedPanelRef = useRef<HTMLDivElement>(null)

  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const loadTokens = useCallback(async () => {
    setListState('loading')
    setListError(null)
    try {
      const response = await fetch('/api/settings/tokens')
      const payload = (await response.json().catch(() => ({}))) as { tokens?: ApiToken[]; error?: string }
      if (!response.ok) {
        setListError(payload.error || "Couldn't load your access tokens.")
        setListState('error')
        return
      }
      setTokens(payload.tokens ?? [])
      setListState('ready')
    } catch {
      setListError("Couldn't reach the server. Check your connection and try again.")
      setListState('error')
    }
  }, [])

  useEffect(() => {
    loadTokens()
  }, [loadTokens])

  useEffect(() => {
    if (issued) issuedPanelRef.current?.focus()
  }, [issued])

  async function createToken(event: React.FormEvent) {
    event.preventDefault()
    if (isCreating) return

    const trimmedName = name.trim()
    const scopes = parseScopes(scopesText)
    if (!trimmedName) {
      setCreateError('Give the token a name.')
      return
    }
    if (scopes.length === 0) {
      setCreateError('List at least one scope, e.g. "mcp" or "a2a".')
      return
    }

    setIsCreating(true)
    setCreateError(null)
    setCopyState('idle')
    try {
      const response = await fetch('/api/settings/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, scopes }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        token?: string
        summary?: ApiToken
        error?: string
      }
      if (!response.ok || !payload.token) {
        const message = payload.error || "Couldn't issue a token right now. Try again."
        setCreateError(message)
        onStatus('error', message)
        return
      }

      setIssued({ token: payload.token, name: trimmedName })
      setName('')
      setScopesText('')
      if (payload.summary) setTokens((current) => [payload.summary!, ...current])
      onStatus('success', 'Access token created — copy it now, it will not be shown again.')
    } catch {
      const message = "Couldn't reach the server. Check your connection and try again."
      setCreateError(message)
      onStatus('error', message)
    } finally {
      setIsCreating(false)
    }
  }

  async function copyIssuedToken() {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.token)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget || isRevoking) return
    setIsRevoking(true)
    setRevokeError(null)
    try {
      const response = await fetch(`/api/settings/tokens?id=${encodeURIComponent(revokeTarget.id)}`, {
        method: 'DELETE',
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setRevokeError(payload.error || "Couldn't revoke that token. Try again.")
        return
      }
      setTokens((current) =>
        current.map((t) => (t.id === revokeTarget.id ? { ...t, revokedAt: new Date().toISOString() } : t))
      )
      setRevokeTarget(null)
      onStatus('success', 'Access token revoked.')
    } catch {
      setRevokeError("Couldn't reach the server. Check your connection and try again.")
    } finally {
      setIsRevoking(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Access tokens</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Personal access tokens let an MCP client or an A2A caller act as you without a browser
          session. Treat one like a password — anyone holding it can do whatever its scopes allow.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Create                                                            */}
      {/* ---------------------------------------------------------------- */}
      <form onSubmit={createToken} className="space-y-3 rounded-card border bg-card p-4">
        <div>
          <label htmlFor={nameInputId} className="text-body font-medium text-foreground">
            Name
          </label>
          <Input
            id={nameInputId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_NAME_CHARS}
            placeholder="Laptop MCP client"
            className="mt-2"
            disabled={isCreating}
          />
        </div>
        <div>
          <label htmlFor={scopesInputId} className="text-body font-medium text-foreground">
            Scopes
          </label>
          <p className="mt-0.5 text-caption text-muted-foreground">Comma-separated, e.g. "mcp, a2a".</p>
          <Input
            id={scopesInputId}
            value={scopesText}
            onChange={(event) => setScopesText(event.target.value)}
            placeholder="mcp"
            className="mt-2"
            disabled={isCreating}
          />
        </div>

        {createError && (
          <p className="flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {createError}
          </p>
        )}

        <Button type="submit" disabled={isCreating}>
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          Create token
        </Button>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* Freshly issued token — shown exactly once                        */}
      {/* ---------------------------------------------------------------- */}
      {issued && (
        <div
          ref={issuedPanelRef}
          tabIndex={-1}
          className="space-y-2 rounded-card border border-accent/40 bg-accent-soft p-4 outline-none"
        >
          <p className="text-body font-medium text-accent-deep">"{issued.name}" — copy this now</p>
          <p className="text-caption text-accent-deep/80">
            You will not see this token again. If you lose it, revoke it and create a new one.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-control border bg-card px-3 py-2 text-caption">
              {issued.token}
            </code>
            <Button type="button" variant="outline" onClick={copyIssuedToken} className="shrink-0">
              {copyState === 'copied' ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copyState === 'failed' && (
            <p className="text-caption text-red-700 dark:text-red-300">
              Couldn't copy automatically — select the token above and copy it by hand.
            </p>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setIssued(null)}>
            Done
          </Button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* List                                                              */}
      {/* ---------------------------------------------------------------- */}
      {listState === 'loading' ? (
        <p className="text-caption text-muted-foreground">Loading…</p>
      ) : listState === 'error' ? (
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load your access tokens"
          body={listError ?? ''}
          action={
            <Button size="sm" onClick={loadTokens}>
              Retry
            </Button>
          }
        />
      ) : tokens.length === 0 ? (
        <div className="rounded-card border border-dashed p-6 text-center text-caption text-muted-foreground">
          No access tokens yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {tokens.map((token) => {
            const isLive = !token.revokedAt && (!token.expiresAt || new Date(token.expiresAt).getTime() > Date.now())
            return (
              <li key={token.id} className="rounded-card border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-body font-medium text-foreground">
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {token.name}
                      </span>
                      {token.scopes.map((scope) => (
                        <Badge key={scope} tone={isLive ? 'accent' : 'neutral'}>
                          {scope}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-caption text-muted-foreground">
                      {describeExpiry(token)}
                      {token.lastUsedAt && ` · last used ${new Date(token.lastUsedAt).toLocaleString()}`}
                    </p>
                  </div>
                  {isLive && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
                      onClick={() => {
                        setRevokeError(null)
                        setRevokeTarget(token)
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Revoke confirmation                                              */}
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke this token?</DialogTitle>
            <DialogDescription>
              {revokeTarget ? `"${revokeTarget.name}" will stop working immediately.` : 'This token stops working immediately.'}
            </DialogDescription>
          </DialogHeader>

          {revokeError && (
            <p className="flex items-start gap-1.5 text-caption text-red-700 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {revokeError}
            </p>
          )}

          <DialogFooter className="gap-2 sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setRevokeTarget(null)} disabled={isRevoking}>
              Keep it active
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRevoke} disabled={isRevoking}>
              {isRevoking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldOff className="h-4 w-4" aria-hidden />}
              Revoke token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
