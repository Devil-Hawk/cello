'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  Loader2,
  Plug,
  Plus,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface McpTabProps {
  onStatus: (status: 'success' | 'error', message: string) => void
}

type Transport = 'http' | 'sse' | 'stdio'

interface McpServer {
  id: string
  name: string
  transport: Transport
  url: string | null
  hasHeaders: boolean
  enabled: boolean
  lastConnectedAt: string | null
  lastError: string | null
  createdAt: string
}

interface TestResult {
  ok: boolean
  toolCount?: number
  toolNames?: string[]
  error?: string
}

interface FormState {
  id: string | null // null = creating a new server
  name: string
  transport: Transport
  url: string
  headersText: string
}

const EMPTY_FORM: FormState = { id: null, name: '', transport: 'http', url: '', headersText: '' }

/** "Key: Value" per line -> Record<string,string>. Blank lines and lines
 *  without a ':' are ignored so a stray trailing newline never errors. */
function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i

function transportLabel(t: Transport): string {
  return t === 'http' ? 'HTTP (Streamable)' : t === 'sse' ? 'SSE (legacy)' : 'stdio (self-hosted only)'
}

/**
 * Add/edit/test/remove MCP (Model Context Protocol) servers. Each enabled
 * server's tools show up in the copilot as `mcp:<name>:<tool>` — see
 * lib/mcp/registry.ts buildMcpPromptContext and lib/harness/copilot-tools.ts
 * dispatchMcpTool. Connection status shown here is LIVE (the Test button
 * makes a real, timeout-bounded connection attempt), not a cached guess.
 */
export function McpTab({ onStatus }: McpTabProps) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [stdioAvailable, setStdioAvailable] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null) // 'draft' for the open form
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/settings/mcp')
      const data = await res.json()
      if (res.ok) {
        setServers(data.servers ?? [])
        setStdioAvailable(Boolean(data.stdioAvailable))
      } else {
        onStatus('error', data.error ?? 'Failed to load MCP servers')
      }
    } catch {
      onStatus('error', 'Failed to load MCP servers')
    }
    setIsLoading(false)
  }

  function startAdd() {
    setForm({ ...EMPTY_FORM })
    setTestResults((r) => ({ ...r, draft: undefined as unknown as TestResult }))
  }

  function startEdit(s: McpServer) {
    setForm({ id: s.id, name: s.name, transport: s.transport, url: s.url ?? '', headersText: '' })
  }

  function cancelForm() {
    setForm(null)
  }

  async function testDraft() {
    if (!form) return
    setTestingId('draft')
    try {
      const res = await fetch('/api/settings/mcp?testDraft=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name || 'draft',
          transport: form.transport,
          url: form.url,
          headers: parseHeadersText(form.headersText),
        }),
      })
      const data = (await res.json()) as TestResult
      setTestResults((r) => ({ ...r, draft: data }))
      if (!res.ok) onStatus('error', (data as unknown as { error?: string }).error ?? 'Test failed')
    } catch {
      setTestResults((r) => ({ ...r, draft: { ok: false, error: 'Request failed' } }))
    }
    setTestingId(null)
  }

  async function testSaved(id: string) {
    setTestingId(id)
    try {
      const res = await fetch(`/api/settings/mcp?test=${encodeURIComponent(id)}`, { method: 'POST' })
      const data = (await res.json()) as TestResult
      setTestResults((r) => ({ ...r, [id]: data }))
      await load() // pick up the persisted last_connected_at / last_error
    } catch {
      setTestResults((r) => ({ ...r, [id]: { ok: false, error: 'Request failed' } }))
    }
    setTestingId(null)
  }

  async function save() {
    if (!form) return
    const name = form.name.trim()
    if (!NAME_RE.test(name)) {
      onStatus('error', 'Name must be 1-40 characters: letters, numbers, "_" or "-" only.')
      return
    }
    if (form.transport !== 'stdio' && !form.url.trim()) {
      onStatus('error', 'A url is required for http/sse servers.')
      return
    }
    if (form.transport === 'stdio' && !stdioAvailable) {
      onStatus('error', 'stdio servers only work in a self-hosted deployment.')
      return
    }

    setIsSaving(true)
    try {
      const payload = {
        name,
        transport: form.transport,
        url: form.url.trim() || null,
        headers: parseHeadersText(form.headersText),
      }
      const res = form.id
        ? await fetch(`/api/settings/mcp?id=${encodeURIComponent(form.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/settings/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      const data = await res.json()
      if (!res.ok) {
        onStatus('error', data.error ?? 'Failed to save server')
      } else {
        onStatus('success', form.id ? 'Server updated' : 'Server added')
        setForm(null)
        await load()
      }
    } catch {
      onStatus('error', 'Failed to save server')
    }
    setIsSaving(false)
  }

  async function toggleEnabled(s: McpServer) {
    setBusyId(s.id)
    try {
      const res = await fetch(`/api/settings/mcp?id=${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      })
      if (res.ok) {
        setServers((list) => list.map((x) => (x.id === s.id ? { ...x, enabled: !s.enabled } : x)))
      } else {
        const data = await res.json()
        onStatus('error', data.error ?? 'Failed to update server')
      }
    } catch {
      onStatus('error', 'Failed to update server')
    }
    setBusyId(null)
  }

  async function remove(id: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/settings/mcp?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) {
        setServers((list) => list.filter((s) => s.id !== id))
        onStatus('success', 'Server removed')
      } else {
        const data = await res.json()
        onStatus('error', data.error ?? 'Failed to remove server')
      }
    } catch {
      onStatus('error', 'Failed to remove server')
    }
    setBusyId(null)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">MCP servers</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Connect any Model Context Protocol server and its tools become available to the
          copilot as <code className="rounded bg-sunken px-1 py-0.5">mcp:&lt;name&gt;:&lt;tool&gt;</code>.
          Disabling a server removes its tools from the copilot immediately — enforced on every
          call, not just hidden from the list it's shown.
        </p>
      </div>

      <div className="rounded-card border bg-sunken p-4 text-caption text-muted-foreground">
        <p className="font-medium text-foreground">These are third-party servers.</p>
        <p className="mt-1">
          Cello only ever treats what a connected server describes or returns as data for the
          copilot to read — never as instructions it obeys, and never a reason to skip your
          confirmation before a destructive action. Only connect servers you trust.
        </p>
      </div>

      {isLoading ? (
        <p className="text-caption text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3">
          {servers.length === 0 && !form && (
            <div className="rounded-card border border-dashed p-6 text-center text-caption text-muted-foreground">
              No MCP servers connected yet.
            </div>
          )}

          {servers.map((s) => {
            const result = testResults[s.id]
            const isBusy = busyId === s.id
            return (
              <div key={s.id} className="rounded-card border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-body font-medium text-foreground">{s.name}</span>
                      <Badge tone="neutral">{transportLabel(s.transport)}</Badge>
                      {!s.enabled && <Badge tone="neutral">disabled</Badge>}
                      {result ? (
                        result.ok ? (
                          <span className="inline-flex items-center gap-1 text-caption text-success">
                            <CheckCircle className="h-3.5 w-3.5" /> {result.toolCount ?? 0} tools
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-caption text-red-600 dark:text-red-400">
                            <WifiOff className="h-3.5 w-3.5" /> unreachable
                          </span>
                        )
                      ) : s.lastConnectedAt ? (
                        <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                          <Wifi className="h-3.5 w-3.5" /> last connected {new Date(s.lastConnectedAt).toLocaleString()}
                        </span>
                      ) : s.lastError ? (
                        <span className="inline-flex items-center gap-1 text-caption text-red-600 dark:text-red-400">
                          <AlertCircle className="h-3.5 w-3.5" /> never connected
                        </span>
                      ) : null}
                    </div>
                    {s.url && <p className="truncate text-caption text-muted-foreground">{s.url}</p>}
                    {s.hasHeaders && <p className="text-caption text-muted-foreground">Custom headers configured (hidden)</p>}
                    {(result?.error || s.lastError) && (
                      <p className="text-caption text-red-600 dark:text-red-400">{result?.error ?? s.lastError}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => toggleEnabled(s)}
                      disabled={isBusy}
                    >
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : s.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => testSaved(s.id)}
                      disabled={testingId === s.id}
                    >
                      {testingId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                      Test
                    </Button>
                    <Button variant="outline" size="sm" className="h-8" onClick={() => startEdit(s)}>
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10"
                      onClick={() => remove(s.id)}
                      disabled={isBusy}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {result?.ok && result.toolNames && result.toolNames.length > 0 && (
                  <details className="mt-3">
                    <summary className="flex cursor-pointer select-none items-center gap-1 text-caption text-muted-foreground">
                      <ChevronDown className="h-3.5 w-3.5" /> {result.toolNames.length} tool(s)
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {result.toolNames.map((t) => (
                        <code key={t} className="rounded bg-sunken px-1.5 py-0.5 text-caption">
                          mcp:{s.name}:{t}
                        </code>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}

      {form ? (
        <div className="rounded-card border bg-card p-4">
          <p className="mb-3 text-body font-medium text-foreground">
            {form.id ? 'Edit server' : 'Add a server'}
          </p>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-caption font-medium text-foreground">Name</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-server"
                disabled={Boolean(form.id)}
              />
              <p className="mt-1 text-caption text-muted-foreground">
                Letters, numbers, "_", "-" only — this becomes the tool prefix{' '}
                <code className="rounded bg-sunken px-1">mcp:{form.name || '<name>'}:*</code>.
                {form.id && ' Cannot be changed after creation.'}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-caption font-medium text-foreground">Transport</label>
              <Select
                value={form.transport}
                onValueChange={(v) => setForm({ ...form, transport: v as Transport })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP (Streamable HTTP — recommended)</SelectItem>
                  <SelectItem value="sse">SSE (legacy transport)</SelectItem>
                  <SelectItem value="stdio" disabled={!stdioAvailable}>
                    stdio {!stdioAvailable && '— unavailable on this (serverless) deployment'}
                  </SelectItem>
                </SelectContent>
              </Select>
              {form.transport === 'stdio' && (
                <p className="mt-1 text-caption text-muted-foreground">
                  stdio spawns a local process and only works when Cello is self-hosted (never on
                  serverless). The URL field below is the command line to run, e.g.{' '}
                  <code className="rounded bg-sunken px-1">npx -y @scope/server --flag</code>.
                </p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-caption font-medium text-foreground">
                {form.transport === 'stdio' ? 'Command' : 'URL'}
              </label>
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={form.transport === 'stdio' ? 'npx -y @scope/server' : 'https://example.com/mcp'}
              />
            </div>

            <div>
              <label className="mb-1 block text-caption font-medium text-foreground">
                Custom headers {form.id && '(leave blank to keep existing)'}
              </label>
              <Textarea
                value={form.headersText}
                onChange={(e) => setForm({ ...form, headersText: e.target.value })}
                placeholder={'Authorization: Bearer sk-...\nX-Api-Key: ...'}
                rows={3}
                className="font-mono text-caption"
              />
              <p className="mt-1 text-caption text-muted-foreground">
                One <code className="rounded bg-sunken px-1">Header: value</code> per line. Stored
                encrypted; never shown again once saved.
              </p>
            </div>

            {testResults.draft && (
              <div
                className={cn(
                  'rounded-control p-3 text-caption',
                  testResults.draft.ok
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                )}
              >
                {testResults.draft.ok
                  ? `Connected — found ${testResults.draft.toolCount ?? 0} tool(s): ${(testResults.draft.toolNames ?? []).join(', ')}`
                  : `Failed: ${testResults.draft.error}`}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={save} disabled={isSaving}>
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {form.id ? 'Save changes' : 'Add server'}
              </Button>
              <Button variant="outline" onClick={testDraft} disabled={testingId === 'draft'}>
                {testingId === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                Test connection
              </Button>
              <Button variant="ghost" onClick={cancelForm} disabled={isSaving}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={startAdd} className="h-9">
          <Plus className="h-4 w-4" />
          Add MCP server
        </Button>
      )}
    </div>
  )
}
