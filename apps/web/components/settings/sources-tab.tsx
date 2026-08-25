'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Database,
  FileText,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User as UserIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'
import type { KbSearchHit, KbSource } from '@/lib/kb/types'

export interface SourcesTabProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

/** The only kinds this UI can create — the ones with a real sync connector
 *  (lib/kb/connectors/*). linkedin_export / gmail / dossier exist in the
 *  schema for later work but have no connector yet. */
type CreatableKind = 'paste' | 'url' | 'resume' | 'apify'

const KIND_META: Record<CreatableKind, { label: string; icon: typeof FileText; blurb: string }> = {
  paste: {
    label: 'Paste text',
    icon: FileText,
    blurb: 'Paste notes, an offer letter, anything — indexed instantly. Works with zero API keys.',
  },
  url: {
    label: 'Web page',
    icon: Link2,
    blurb: 'Fetch one public page and index its readable text. No key needed.',
  },
  resume: {
    label: 'My resume',
    icon: UserIcon,
    blurb: 'Reindex the resume already on file so it shows up in knowledge-base search too.',
  },
  apify: {
    label: 'Apify (BYOK)',
    icon: Bot,
    blurb: 'Run your own Apify actor and index its results. Off by default — see the notice below.',
  },
}

function kindIcon(kind: string) {
  const meta = (KIND_META as Record<string, { icon: typeof FileText }>)[kind]
  return meta?.icon ?? Database
}

function kindLabel(kind: string) {
  const meta = (KIND_META as Record<string, { label: string }>)[kind]
  return meta?.label ?? kind
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Small labeled on/off pill — same visual language as targeting-tab's remote toggle. */
function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-card transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

/** Persistent, always-visible disclosure — never a tooltip. Apify runs bill the
 *  user's OWN account, and LinkedIn's terms restrict scraping, so the choice
 *  (and the risk) is visibly theirs, not something Cello does on their behalf. */
function ApifyDisclosure() {
  return (
    <div className="flex gap-3 rounded-card border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="space-y-1 text-caption text-amber-900 dark:text-amber-200">
        <p className="font-medium">Apify runs bill your own Apify account — Cello does not scrape on your behalf.</p>
        <p>
          Apify actors run under YOUR Apify token, and any usage is billed directly to your Apify
          account — Cello never provides or subsidizes a token. Some popular actors target LinkedIn;
          LinkedIn&apos;s Terms of Service restrict automated scraping of its site. Whether to run such an
          actor — and the risk of doing so — is entirely your choice. Cello itself never scrapes
          LinkedIn; it only calls the actor id you configure, on your own account, when you explicitly
          enable it.
        </p>
      </div>
    </div>
  )
}

interface SourceRowProps {
  source: KbSource
  busy: boolean
  onSync: () => void
  onToggle: () => void
  onDelete: () => void
  onAddPasteDoc: (content: string) => Promise<void>
}

function SourceRow({ source, busy, onSync, onToggle, onDelete, onAddPasteDoc }: SourceRowProps) {
  const Icon = kindIcon(source.kind)
  const [addingText, setAddingText] = useState(false)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const config = (source.config ?? {}) as Record<string, unknown>

  async function submitDraft() {
    if (!draft.trim()) return
    setSubmitting(true)
    try {
      await onAddPasteDoc(draft)
      setDraft('')
      setAddingText(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-card border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border bg-sunken">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-body font-medium text-foreground">
                {source.label || kindLabel(source.kind)}
              </span>
              <Badge tone="neutral">{kindLabel(source.kind)}</Badge>
              {!source.enabled && <Badge tone="neutral">Disabled</Badge>}
            </div>
            {source.kind === 'url' && typeof config.url === 'string' && (
              <p className="truncate text-caption text-muted-foreground">{config.url}</p>
            )}
            {source.kind === 'apify' && typeof config.actorId === 'string' && (
              <p className="truncate text-caption text-muted-foreground">actor: {config.actorId}</p>
            )}
            <p className="text-caption text-muted-foreground">
              Last synced: {timeAgo(source.last_synced_at)}
            </p>
            {source.last_error && (
              <p className="flex items-start gap-1 text-caption text-red-600 dark:text-red-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{source.last_error}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={source.enabled} disabled={busy} onChange={onToggle} />
          {source.kind === 'paste' && (
            <Button variant="outline" size="sm" onClick={() => setAddingText((v) => !v)} disabled={busy}>
              <Plus className="h-3.5 w-3.5" />
              Add text
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onSync} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {source.kind === 'apify' && (
        <div className="mt-3">
          <ApifyDisclosure />
        </div>
      )}

      {addingText && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste more text to index under this source…"
            className="min-h-[100px]"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setAddingText(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={submitDraft} disabled={submitting || !draft.trim()}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Index
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function SourcesTab({ onStatus }: SourcesTabProps) {
  const [sources, setSources] = useState<KbSource[]>([])
  const [loading, setLoading] = useState(true)
  const [hasApifyToken, setHasApifyToken] = useState(false)
  const [defaultActorId, setDefaultActorId] = useState('')

  // add-source form state
  const [kind, setKind] = useState<CreatableKind>('paste')
  const [label, setLabel] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [url, setUrl] = useState('')
  const [actorId, setActorId] = useState('')
  const [actorInput, setActorInput] = useState('')
  const [showActorInput, setShowActorInput] = useState(false)
  const [creating, setCreating] = useState(false)

  // per-source busy state
  const [busyId, setBusyId] = useState<string | null>(null)

  // apify token field
  const [apifyTokenDraft, setApifyTokenDraft] = useState('')
  const [savingToken, setSavingToken] = useState(false)

  // search
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchHits, setSearchHits] = useState<KbSearchHit[] | null>(null)

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch('/api/kb/sources')
      const data = await res.json()
      if (res.ok) setSources(data.sources ?? [])
    } catch {
      // best-effort; the tab still renders with whatever we had
    }
  }, [])

  const loadApifyStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/sources')
      const data = await res.json()
      if (res.ok) {
        setHasApifyToken(Boolean(data.hasApifyToken))
        setDefaultActorId(data.defaultApifyActorId || '')
        setActorId((prev) => prev || data.defaultApifyActorId || '')
      }
    } catch {
      // ignore — the Apify card just shows "not configured"
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadSources(), loadApifyStatus()]).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSync(id: string, opts: { silent?: boolean } = {}) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/kb/sources/${id}/sync`, { method: 'POST' })
      const data = await res.json()
      if (!opts.silent) {
        onStatus(data.ok ? 'success' : 'error', data.message || (data.ok ? 'Synced' : 'Sync did not complete'))
      }
      await loadSources()
      return data
    } catch (e) {
      if (!opts.silent) onStatus('error', e instanceof Error ? e.message : 'Sync failed')
      return null
    } finally {
      setBusyId(null)
    }
  }

  async function createSource() {
    setCreating(true)
    try {
      let config: Record<string, unknown> | undefined
      if (kind === 'url') {
        if (!url.trim()) {
          onStatus('error', 'Enter a URL to fetch')
          return
        }
        config = { url: url.trim() }
      } else if (kind === 'apify') {
        if (!actorId.trim()) {
          onStatus('error', 'Enter an Apify actor id')
          return
        }
        let parsedInput: Record<string, unknown> | undefined
        if (actorInput.trim()) {
          try {
            parsedInput = JSON.parse(actorInput)
          } catch {
            onStatus('error', 'Actor input must be valid JSON')
            return
          }
        }
        config = { actorId: actorId.trim(), input: parsedInput }
      }

      const res = await fetch('/api/kb/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, label: label.trim() || undefined, config }),
      })
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error || 'Failed to create source')
        return
      }

      const created: KbSource = data.source

      if (kind === 'paste' && pasteText.trim()) {
        const docRes = await fetch(`/api/kb/sources/${created.id}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: pasteText, title: label.trim() || undefined }),
        })
        const docData = await docRes.json()
        onStatus(
          docRes.ok ? 'success' : 'error',
          docRes.ok ? docData.message || 'Pasted text indexed' : `Source created, but indexing failed: ${docData.error || 'unknown error'}`
        )
      } else if (kind === 'resume' || kind === 'url') {
        // No cost, no ToS implication — sync right away instead of making the
        // user click twice.
        await runSync(created.id, { silent: true })
        onStatus('success', `${KIND_META[kind].label} source added and synced.`)
      } else {
        onStatus('success', 'Apify source added — it stays disabled until you enable it below and add a token.')
      }

      setLabel('')
      setPasteText('')
      setUrl('')
      setActorInput('')
      await loadSources()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to create source')
    } finally {
      setCreating(false)
    }
  }

  async function toggleEnabled(source: KbSource) {
    setBusyId(source.id)
    try {
      const res = await fetch(`/api/kb/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !source.enabled }),
      })
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error || 'Failed to update source')
        return
      }
      await loadSources()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to update source')
    } finally {
      setBusyId(null)
    }
  }

  async function removeSource(id: string) {
    if (!confirm('Delete this source and everything indexed under it?')) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/kb/sources/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        onStatus('error', data?.error || 'Failed to delete source')
        return
      }
      onStatus('success', 'Source deleted')
      await loadSources()
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to delete source')
    } finally {
      setBusyId(null)
    }
  }

  async function addPasteDoc(source: KbSource, content: string) {
    const res = await fetch(`/api/kb/sources/${source.id}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    const data = await res.json()
    onStatus(res.ok ? 'success' : 'error', res.ok ? data.message || 'Indexed' : data.error || 'Failed to index text')
    if (res.ok) await loadSources()
  }

  async function saveApifyToken() {
    if (!apifyTokenDraft.trim()) return
    setSavingToken(true)
    try {
      const res = await fetch('/api/settings/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apifyToken: apifyTokenDraft }),
      })
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error || 'Failed to save token')
        return
      }
      setHasApifyToken(true)
      setApifyTokenDraft('')
      onStatus('success', 'Apify token saved (encrypted)')
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      setSavingToken(false)
    }
  }

  async function removeApifyToken() {
    setSavingToken(true)
    try {
      const res = await fetch('/api/settings/sources', { method: 'DELETE' })
      if (!res.ok) {
        onStatus('error', 'Failed to remove token')
        return
      }
      setHasApifyToken(false)
      onStatus('success', 'Apify token removed')
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Failed to remove token')
    } finally {
      setSavingToken(false)
    }
  }

  async function runSearch() {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchHits(null)
    try {
      const res = await fetch(`/api/kb/search?q=${encodeURIComponent(searchQuery)}&limit=8`)
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error || 'Search failed')
        return
      }
      setSearchHits(data.hits ?? [])
    } catch (e) {
      onStatus('error', e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-display text-section text-foreground">Sources</h2>
        <p className="text-caption text-muted-foreground">
          A personal knowledge base the copilot can search and cite from — pasted notes, indexed web
          pages, your resume, and (opt-in) Apify results. Every connector below is off until you
          create it; nothing syncs on a schedule, only when you ask it to.
        </p>
      </div>

      {/* Add a source */}
      <div className="space-y-4 rounded-card border bg-card p-5">
        <p className="text-body font-medium text-foreground">Add a source</p>

        <Segmented
          aria-label="Source kind"
          value={kind}
          onValueChange={(v) => setKind(v as CreatableKind)}
          options={(Object.keys(KIND_META) as CreatableKind[]).map((k) => ({
            value: k,
            label: KIND_META[k].label,
          }))}
        />
        <p className="text-caption text-muted-foreground">{KIND_META[kind].blurb}</p>

        <Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />

        {kind === 'paste' && (
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste the text to index…"
            className="min-h-[120px]"
          />
        )}

        {kind === 'url' && (
          <Input
            type="url"
            placeholder="https://example.com/article"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}

        {kind === 'resume' && (
          <p className="text-caption text-muted-foreground">
            No config needed — this reindexes the resume text already on your Profile tab.
          </p>
        )}

        {kind === 'apify' && (
          <div className="space-y-3">
            <ApifyDisclosure />
            <Input
              placeholder={defaultActorId || 'username/actor-name'}
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
            />
            <p className="text-caption text-muted-foreground">
              Any actor id on your own Apify account — nothing runs until you enable this source and
              click Sync.
            </p>
            <button
              type="button"
              onClick={() => setShowActorInput((v) => !v)}
              className="flex items-center gap-1 text-caption text-accent-deep hover:underline"
            >
              {showActorInput ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Actor input (advanced, optional JSON)
            </button>
            {showActorInput && (
              <Textarea
                value={actorInput}
                onChange={(e) => setActorInput(e.target.value)}
                placeholder='{"startUrls": [...]}'
                className="min-h-[80px] font-mono text-caption"
              />
            )}
            {!hasApifyToken && (
              <p className="text-caption text-muted-foreground">
                You&apos;ll need to add your Apify API token below before this source can sync.
              </p>
            )}
          </div>
        )}

        <div>
          <Button
            onClick={createSource}
            disabled={
              creating ||
              (kind === 'url' && !url.trim()) ||
              (kind === 'apify' && !actorId.trim())
            }
          >
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}
            <Plus className="h-4 w-4" />
            Add source
          </Button>
        </div>
      </div>

      {/* Apify token */}
      <div className="space-y-3 rounded-card border bg-card p-5">
        <div className="flex items-center justify-between">
          <p className="text-body font-medium text-foreground">Apify API token</p>
          {hasApifyToken && (
            <span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-3 w-3" />
              Configured
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            type="password"
            value={apifyTokenDraft}
            onChange={(e) => setApifyTokenDraft(e.target.value)}
            placeholder={hasApifyToken ? '••••••••••••••••' : 'apify_api_...'}
            className="flex-1 font-mono"
          />
          <Button onClick={saveApifyToken} disabled={savingToken || !apifyTokenDraft.trim()}>
            {savingToken && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
          {hasApifyToken && (
            <Button
              variant="outline"
              onClick={removeApifyToken}
              disabled={savingToken}
              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Remove
            </Button>
          )}
        </div>
        <p className="text-caption text-muted-foreground">
          Stored encrypted, the same way as your other API keys. Get a token from{' '}
          <a
            href="https://console.apify.com/settings/integrations"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-deep hover:underline"
          >
            console.apify.com
          </a>
          . This token is only ever used to call the actor id you configure above.
        </p>
      </div>

      {/* Existing sources */}
      <div className="space-y-3">
        <p className="text-body font-medium text-foreground">Your sources {sources.length > 0 && `(${sources.length})`}</p>
        {loading ? (
          <p className="text-caption text-muted-foreground">Loading…</p>
        ) : sources.length === 0 ? (
          <p className="rounded-card border border-dashed p-6 text-center text-caption text-muted-foreground">
            No sources yet — add one above. Paste text works with no keys at all.
          </p>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                busy={busyId === source.id}
                onSync={() => runSync(source.id)}
                onToggle={() => toggleEnabled(source)}
                onDelete={() => removeSource(source.id)}
                onAddPasteDoc={(content) => addPasteDoc(source, content)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Search */}
      <div className="space-y-3 rounded-card border bg-card p-5">
        <p className="text-body font-medium text-foreground">Search your knowledge base</p>
        <p className="text-caption text-muted-foreground">
          The same full-text search the copilot&apos;s <code>search_kb</code> tool uses, so answers can
          cite what&apos;s indexed here.
        </p>
        <div className="flex gap-2">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch()
            }}
            placeholder="Search indexed content…"
            className="flex-1"
          />
          <Button onClick={runSearch} disabled={searching || !searchQuery.trim()}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </div>
        {searchHits !== null && (
          <div className="space-y-2 pt-1">
            {searchHits.length === 0 ? (
              <p className="text-caption text-muted-foreground">No matches.</p>
            ) : (
              searchHits.map((hit) => (
                <div key={hit.chunkId} className="rounded-control border bg-sunken p-3">
                  <p className="text-caption font-medium text-foreground">{hit.title || hit.url || 'Untitled'}</p>
                  <p className="mt-1 text-caption text-muted-foreground">{hit.content}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
