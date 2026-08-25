'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  PlayCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface SearchTabProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

type BackendId = 'tavily' | 'serper' | 'exa' | 'searxng' | 'duckduckgo'
type KeyProvider = 'tavily' | 'serper' | 'exa'

interface BackendStatus {
  id: BackendId
  label: string
  configured: boolean
  codeAvailable: boolean
  health: { reason: string; detail: string | null; retryAfterMs: number } | null
}

interface SearchSettingsStatus {
  hasTavily: boolean
  hasSerper: boolean
  hasExa: boolean
  hasSearxng: boolean
  searxngEnvConfigured: boolean
  backends: BackendStatus[]
}

const BLURB: Record<KeyProvider, { name: string; tradeoff: string; getKeyUrl: string; getKeyHost: string }> = {
  tavily: {
    name: 'Tavily',
    tradeoff: '1,000 free searches every month, recurring, no credit card. The best free default for a deployed Cello.',
    getKeyUrl: 'https://app.tavily.com',
    getKeyHost: 'app.tavily.com',
  },
  serper: {
    name: 'Serper',
    tradeoff: 'Real Google results. 2,500 free queries ONE TIME (not monthly), then $0.30–$1.00 per 1,000.',
    getKeyUrl: 'https://serper.dev',
    getKeyHost: 'serper.dev',
  },
  exa: {
    name: 'Exa',
    tradeoff: '~$10/month in free credits, then ~$7 per 1,000 searches. Higher quality, highest cost of the three.',
    getKeyUrl: 'https://dashboard.exa.ai',
    getKeyHost: 'dashboard.exa.ai',
  },
}

function formatRetry(ms: number): string {
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60_000)
  return mins <= 1 ? '~1m' : `~${mins}m`
}

function KeyField({
  provider,
  configured,
  value,
  onChange,
  onSave,
  onRemove,
  onTest,
  busy,
  testing,
}: {
  provider: KeyProvider
  configured: boolean
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onRemove: () => void
  onTest: () => void
  busy: boolean
  testing: boolean
}) {
  const [show, setShow] = useState(false)
  const meta = BLURB[provider]

  return (
    <div className="rounded-card border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <label className="text-body font-medium text-foreground">{meta.name} API key</label>
        {configured && (
          <span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-3 w-3" />
            Configured
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
              'flex h-9 w-full rounded-control border border-input bg-card px-3 py-1 pr-10 font-mono text-body text-foreground transition-colors',
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'
            )}
            placeholder={configured ? '••••••••••••••••' : `Paste your ${meta.name} key`}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={show ? 'Hide key' : 'Show key'}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button size="sm" className="h-9" onClick={onSave} disabled={busy || !value.trim()}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
        {configured && (
          <Button variant="outline" size="sm" className="h-9" onClick={onTest} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
            Test
          </Button>
        )}
        {configured && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            className="h-9 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            Remove
          </Button>
        )}
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        {meta.tradeoff} Get a key at{' '}
        <a href={meta.getKeyUrl} target="_blank" rel="noopener noreferrer" className="text-accent-deep hover:underline">
          {meta.getKeyHost}
        </a>
        .
      </p>
    </div>
  )
}

function StatusRow({ backend }: { backend: BackendStatus }) {
  const isKeyless = backend.id === 'duckduckgo'
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="text-body font-medium text-foreground">{backend.label}</span>
        {isKeyless && <Badge tone="neutral">Free, keyless</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!backend.codeAvailable ? (
          <Badge tone="warn">Coming soon</Badge>
        ) : backend.configured || isKeyless ? (
          <Badge tone="good">{isKeyless ? 'Always on' : 'Configured'}</Badge>
        ) : (
          <Badge tone="muted">Not configured</Badge>
        )}
        {backend.health && (
          <span className="flex items-center gap-1 text-caption text-amber-700 dark:text-amber-400">
            <Clock className="h-3 w-3" />
            {backend.health.reason === 'blocked' ? 'Recently blocked' : `Recently failed (${backend.health.reason})`} — retrying automatically in {formatRetry(backend.health.retryAfterMs)}
          </span>
        )}
      </div>
    </div>
  )
}

export function SearchTab({ onStatus }: SearchTabProps) {
  const [status, setStatus] = useState<SearchSettingsStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const [drafts, setDrafts] = useState<Record<KeyProvider, string>>({ tavily: '', serper: '', exa: '' })
  const [searxngDraft, setSearxngDraft] = useState('')
  const [savingField, setSavingField] = useState<string | null>(null)
  const [testingField, setTestingField] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/search')
      const data = await res.json()
      if (res.ok) setStatus(data)
    } catch {
      // best-effort — the tab still renders, just without live status
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  async function saveKey(provider: KeyProvider) {
    const value = drafts[provider].trim()
    if (!value) return
    setSavingField(provider)
    try {
      const res = await fetch('/api/settings/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [provider]: value }),
      })
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error || `Failed to save ${BLURB[provider].name} key`)
        return
      }
      onStatus('success', `${BLURB[provider].name} key saved (encrypted)`)
      setDrafts((d) => ({ ...d, [provider]: '' }))
      await load()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : `Failed to save ${BLURB[provider].name} key`)
    } finally {
      setSavingField(null)
    }
  }

  async function removeKey(provider: KeyProvider) {
    setSavingField(provider)
    try {
      const res = await fetch(`/api/settings/search?provider=${provider}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        onStatus('error', data?.error || `Failed to remove ${BLURB[provider].name} key`)
        return
      }
      onStatus('success', `${BLURB[provider].name} key removed`)
      await load()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : `Failed to remove ${BLURB[provider].name} key`)
    } finally {
      setSavingField(null)
    }
  }

  async function saveSearxng() {
    const value = searxngDraft.trim()
    if (!value) return
    setSavingField('searxng')
    try {
      const res = await fetch('/api/settings/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searxngUrl: value }),
      })
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error || 'Failed to save SearXNG URL')
        return
      }
      onStatus('success', 'SearXNG URL saved')
      setSearxngDraft('')
      await load()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to save SearXNG URL')
    } finally {
      setSavingField(null)
    }
  }

  async function removeSearxng() {
    setSavingField('searxng')
    try {
      const res = await fetch('/api/settings/search?provider=searxng', { method: 'DELETE' })
      if (!res.ok) {
        onStatus('error', 'Failed to remove SearXNG URL')
        return
      }
      onStatus('success', 'SearXNG URL removed')
      await load()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to remove SearXNG URL')
    } finally {
      setSavingField(null)
    }
  }

  async function testBackend(id: BackendId) {
    setTestingField(id)
    try {
      const res = await fetch(`/api/search?q=test+query&limit=1&backend=${id}`)
      const data = await res.json()
      if (data.ok) {
        onStatus('success', `${id} responded successfully (${data.count} result${data.count === 1 ? '' : 's'}).`)
      } else {
        onStatus('error', `${id} failed: ${data.reason ?? 'unknown'}${data.detail ? ` — ${data.detail}` : ''}`)
      }
      await load()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : `Failed to test ${id}`)
    } finally {
      setTestingField(null)
    }
  }

  const anyKeyConfigured = Boolean(status?.hasTavily || status?.hasSerper || status?.hasExa || status?.hasSearxng)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Search</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Cello&apos;s web_search tool — used by both the copilot&apos;s own web_search tool and automated job
          discovery — tries every backend you configure below, in order, and only gives up once all of them
          have failed, so a job search keeps working even if one backend is temporarily down.
        </p>
      </div>

      <div className="flex gap-3 rounded-card border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1 text-caption text-amber-900 dark:text-amber-200">
          <p className="font-medium">Be honest with yourself about DuckDuckGo.</p>
          <p>
            The free, keyless DuckDuckGo backend works out of the box, but datacenter/VPS IPs (which is
            usually where a self-hosted or deployed Cello runs) get bot-challenged on the very first
            request. {anyKeyConfigured
              ? 'You have at least one BYOK backend configured below, so DuckDuckGo is only a fallback for you now.'
              : 'With no key configured below, open-web job discovery may not work reliably from a deployed server — add a Tavily key (free, recurring) for a real fix.'}
          </p>
        </div>
      </div>

      <div className="space-y-1 rounded-card border bg-card p-4">
        <p className="mb-1 text-body font-medium text-foreground">Backend status</p>
        {loading ? (
          <p className="text-caption text-muted-foreground">Loading…</p>
        ) : status ? (
          status.backends.map((b) => <StatusRow key={b.id} backend={b} />)
        ) : (
          <p className="text-caption text-muted-foreground">Couldn&apos;t load live status — the tool still works, this is just the diagnostic view.</p>
        )}
      </div>

      <div className="space-y-4">
        <p className="text-body font-medium text-foreground">API keys (tried in this order)</p>
        <KeyField
          provider="tavily"
          configured={Boolean(status?.hasTavily)}
          value={drafts.tavily}
          onChange={(v) => setDrafts((d) => ({ ...d, tavily: v }))}
          onSave={() => saveKey('tavily')}
          onRemove={() => removeKey('tavily')}
          onTest={() => testBackend('tavily')}
          busy={savingField === 'tavily'}
          testing={testingField === 'tavily'}
        />
        <KeyField
          provider="serper"
          configured={Boolean(status?.hasSerper)}
          value={drafts.serper}
          onChange={(v) => setDrafts((d) => ({ ...d, serper: v }))}
          onSave={() => saveKey('serper')}
          onRemove={() => removeKey('serper')}
          onTest={() => testBackend('serper')}
          busy={savingField === 'serper'}
          testing={testingField === 'serper'}
        />
        <KeyField
          provider="exa"
          configured={Boolean(status?.hasExa)}
          value={drafts.exa}
          onChange={(v) => setDrafts((d) => ({ ...d, exa: v }))}
          onSave={() => saveKey('exa')}
          onRemove={() => removeKey('exa')}
          onTest={() => testBackend('exa')}
          busy={savingField === 'exa'}
          testing={testingField === 'exa'}
        />
      </div>

      <div className="rounded-card border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="flex items-center gap-2 text-body font-medium text-foreground">
            <Globe className="h-4 w-4 text-muted-foreground" />
            SearXNG instance URL
          </label>
          {status?.hasSearxng && (
            <span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-3 w-3" />
              Configured
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            type="url"
            value={searxngDraft}
            onChange={(e) => setSearxngDraft(e.target.value)}
            placeholder={status?.hasSearxng ? 'https://searx.example.com' : 'https://your-searxng-instance.example.com'}
            className="flex-1"
          />
          <Button size="sm" className="h-9" onClick={saveSearxng} disabled={savingField === 'searxng' || !searxngDraft.trim()}>
            {savingField === 'searxng' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          {status?.hasSearxng && (
            <Button variant="outline" size="sm" className="h-9" onClick={() => testBackend('searxng')} disabled={testingField === 'searxng'}>
              {testingField === 'searxng' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              Test
            </Button>
          )}
          {status?.hasSearxng && (
            <Button
              variant="outline"
              size="sm"
              onClick={removeSearxng}
              disabled={savingField === 'searxng'}
              className="h-9 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Remove
            </Button>
          )}
        </div>
        <p className="mt-2 text-caption text-muted-foreground">
          Zero-cost-forever option: point this at your own SearXNG instance and get results with no API
          key, no per-search cost, no vendor at all.{' '}
          {status?.searxngEnvConfigured
            ? 'A deployment-wide SEARXNG_BASE_URL is also set — your per-user URL above takes priority over it.'
            : 'Self-hosting for every user on this deployment? Set the SEARXNG_BASE_URL environment variable instead of configuring this per-user.'}
        </p>
      </div>
    </div>
  )
}
