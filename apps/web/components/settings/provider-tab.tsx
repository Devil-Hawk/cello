'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type ProviderId = 'openrouter' | 'local-cli' | 'local-server'
type LocalCliId = 'claude' | 'codex' | 'gemini'

interface ProviderCapabilities {
  json: boolean
  reasoning: boolean
  cachePrefix: boolean
  maxTokens: boolean
  requiresApiKey: boolean
  selfHostedOnly: boolean
}

interface CliAvailability {
  id: LocalCliId
  label: string
  binary: string
  available: boolean
  reason?: string
}

interface ProviderStatus {
  selfHosted: boolean
  active: ProviderId
  preferences: {
    active: ProviderId
    localCli: LocalCliId
    localServerBaseUrl: string
    localServerModel: string
  }
  providers: {
    openrouter: { label: string; description: string; capabilities: ProviderCapabilities; available: boolean; reason?: string }
    'local-cli': { label: string; description: string; capabilities: ProviderCapabilities; available: boolean; reason?: string; clis: CliAvailability[] }
    'local-server': { label: string; description: string; capabilities: ProviderCapabilities; available: boolean; reason?: string; models?: string[] }
  }
}

export interface ProviderTabProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

function AvailabilityBadge({ available, reason }: { available: boolean; reason?: string }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-caption',
        available ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
      )}
      title={reason}
    >
      {available ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {available ? 'Available' : 'Unavailable'}
    </span>
  )
}

/**
 * LLM backend selector. Reports LIVE availability (binary on PATH, local
 * server reachable) from GET /api/settings/providers rather than just
 * showing what's configured — a stale "available" badge would be worse than
 * none. Persists the choice via POST to the same route.
 */
export function ProviderTab({ onStatus }: ProviderTabProps) {
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const [active, setActive] = useState<ProviderId>('openrouter')
  const [localCli, setLocalCli] = useState<LocalCliId>('claude')
  const [localServerBaseUrl, setLocalServerBaseUrl] = useState('')
  const [localServerModel, setLocalServerModel] = useState('')

  async function load() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/settings/providers')
      if (res.ok) {
        const data: ProviderStatus = await res.json()
        setStatus(data)
        setActive(data.preferences.active)
        setLocalCli(data.preferences.localCli)
        setLocalServerBaseUrl(data.preferences.localServerBaseUrl)
        setLocalServerModel(data.preferences.localServerModel)
      }
    } catch {
      // Leave defaults — the save button will still work once the network's back.
    }
    setIsLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    setIsSaving(true)
    try {
      const res = await fetch('/api/settings/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: active,
          localCli,
          localServerBaseUrl,
          localServerModel,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        onStatus('error', result.error || 'Failed to save provider')
      } else {
        onStatus('success', 'Provider preference saved')
        await load()
      }
    } catch {
      onStatus('error', 'Failed to save provider')
    }
    setIsSaving(false)
  }

  if (isLoading || !status) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-32 animate-pulse rounded bg-sunken" />
        <div className="h-24 w-full animate-pulse rounded-card bg-sunken" />
        <div className="h-24 w-full animate-pulse rounded-card bg-sunken" />
      </div>
    )
  }

  const dirty =
    active !== status.preferences.active ||
    localCli !== status.preferences.localCli ||
    localServerBaseUrl !== status.preferences.localServerBaseUrl ||
    localServerModel !== status.preferences.localServerModel

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Provider</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Choose what actually runs your LLM calls. OpenRouter is the default and works everywhere Cello
          runs. The other two never leave your machine — but they only work when Cello is self-hosted.
        </p>
      </div>

      {!status.selfHosted && (
        <div className="flex items-start gap-2 rounded-card bg-amber-50 p-3 text-caption text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This Cello instance is running on Vercel serverless — local CLI and local server providers
            cannot work here (no binaries, no access to your network). Self-host Cello to use them.
          </span>
        </div>
      )}

      <div className="space-y-3">
        {/* OpenRouter */}
        <button
          type="button"
          onClick={() => setActive('openrouter')}
          className={cn(
            'flex w-full items-start gap-3 rounded-card border p-4 text-left transition-colors',
            active === 'openrouter' ? 'border-primary bg-accent-soft' : 'border-border bg-card hover:bg-muted'
          )}
        >
          <RadioDot active={active === 'openrouter'} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-body font-medium text-foreground">{status.providers.openrouter.label}</span>
              <AvailabilityBadge
                available={status.providers.openrouter.available}
                reason={status.providers.openrouter.reason}
              />
            </span>
            <span className="mt-0.5 block text-caption text-muted-foreground">
              {status.providers.openrouter.description}
            </span>
            {!status.providers.openrouter.available && (
              <span className="mt-1 block text-caption text-amber-700 dark:text-amber-400">
                {status.providers.openrouter.reason}
              </span>
            )}
          </span>
        </button>

        {/* Local CLI */}
        <div
          className={cn(
            'rounded-card border p-4 transition-colors',
            active === 'local-cli' ? 'border-primary bg-accent-soft' : 'border-border bg-card'
          )}
        >
          <button type="button" onClick={() => setActive('local-cli')} className="flex w-full items-start gap-3 text-left">
            <RadioDot active={active === 'local-cli'} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-body font-medium text-foreground">{status.providers['local-cli'].label}</span>
                <AvailabilityBadge
                  available={status.providers['local-cli'].available}
                  reason={status.providers['local-cli'].reason}
                />
              </span>
              <span className="mt-0.5 block text-caption text-muted-foreground">
                {status.providers['local-cli'].description}
              </span>
            </span>
          </button>

          <div className="mt-3 space-y-1.5 pl-7">
            {status.providers['local-cli'].clis.map((cli) => (
              <label
                key={cli.id}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-control border px-2.5 py-1.5 text-caption',
                  localCli === cli.id ? 'border-primary' : 'border-border'
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="localCli"
                    checked={localCli === cli.id}
                    onChange={() => {
                      setLocalCli(cli.id)
                      setActive('local-cli')
                    }}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-foreground">{cli.label}</span>
                  <span className="font-mono text-muted-foreground/70">{cli.binary}</span>
                </span>
                <AvailabilityBadge available={cli.available} reason={cli.reason} />
              </label>
            ))}
          </div>
        </div>

        {/* Local server */}
        <div
          className={cn(
            'rounded-card border p-4 transition-colors',
            active === 'local-server' ? 'border-primary bg-accent-soft' : 'border-border bg-card'
          )}
        >
          <button
            type="button"
            onClick={() => setActive('local-server')}
            className="flex w-full items-start gap-3 text-left"
          >
            <RadioDot active={active === 'local-server'} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-body font-medium text-foreground">{status.providers['local-server'].label}</span>
                <AvailabilityBadge
                  available={status.providers['local-server'].available}
                  reason={status.providers['local-server'].reason}
                />
              </span>
              <span className="mt-0.5 block text-caption text-muted-foreground">
                {status.providers['local-server'].description}
              </span>
              {status.providers['local-server'].reason && (
                <span className="mt-1 block text-caption text-amber-700 dark:text-amber-400">
                  {status.providers['local-server'].reason}
                </span>
              )}
            </span>
          </button>

          <div className="mt-3 grid grid-cols-1 gap-2 pl-7 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-caption text-muted-foreground">Base URL</span>
              <Input
                value={localServerBaseUrl}
                onChange={(e) => {
                  setLocalServerBaseUrl(e.target.value)
                  setActive('local-server')
                }}
                placeholder="http://localhost:11434/v1"
                className="font-mono"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-muted-foreground">Model id</span>
              <Input
                value={localServerModel}
                onChange={(e) => {
                  setLocalServerModel(e.target.value)
                  setActive('local-server')
                }}
                placeholder="llama3.1"
                className="font-mono"
              />
            </label>
          </div>
          {status.providers['local-server'].models && status.providers['local-server'].models.length > 0 && (
            <p className="mt-2 pl-7 text-caption text-muted-foreground">
              Server reports: {status.providers['local-server'].models.slice(0, 6).join(', ')}
              {status.providers['local-server'].models.length > 6 ? '…' : ''}
            </p>
          )}
        </div>
      </div>

      <div className="pt-1">
        <Button onClick={save} disabled={isSaving || !dirty}>
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save provider
        </Button>
      </div>
    </div>
  )
}

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
        active ? 'border-primary' : 'border-input'
      )}
      aria-hidden
    >
      {active && <span className="h-2 w-2 rounded-full bg-primary" />}
    </span>
  )
}
