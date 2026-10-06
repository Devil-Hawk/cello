'use client'

// The side panel: a made thing opens beside the conversation from a turn or a tile. It shows the title and kind, every
// version ("Version 3 of 3") with who wrote it, and the text. Edit saves the person's own version through
// /api/artifacts/[id]; the version Cello wrote stays. The conversation narrows beside it and is never covered.
// Add to chat and Use in a new chat work on any made thing. ponytail: Compare, Ask for a change, Save answer, Download and
// Delete arrive with the documents package (K17), the editor (PG8a) and the pipeline's sent-version rule (K13).

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Markdown } from '@/components/chat/markdown'
import { CopyButton } from '@/components/chat/parts'
import { EditorStub } from '@/components/chat/editor.stub'
import type { EditorProps } from '@/components/resume/editor/types'
import { Button } from '@/components/ui/button'

export interface PanelVersion {
  version: number
  author: 'user' | 'cello'
  content: Record<string, unknown>
  content_text: string
  created_at: string
}

export interface PanelThing {
  id: string
  type: string
  title: string
}

const TYPE_WORDS: Record<string, string> = {
  resume: 'Resume',
  cover_letter: 'Cover letter',
  outreach_email: 'Message',
  dossier: 'Research',
  shortlist: 'Shortlist',
  comparison: 'Comparison',
  answer: 'Answer',
}
export const typeWord = (type: string) => TYPE_WORDS[type] ?? type.replace(/_/g, ' ')

/** The one field a person edits in a version, by kind. A kind with no such field is read only here. */
export const EDITABLE_FIELD: Record<string, 'text' | 'body'> = { resume: 'text', cover_letter: 'text', outreach_email: 'body' }

const author = (a: PanelVersion['author']) => (a === 'user' ? 'You wrote this' : 'Cello wrote this')

export interface PanelViewProps {
  thing: PanelThing
  /** Newest first, as /api/artifacts/[id] returns them. */
  versions: PanelVersion[]
  selected: number
  onSelect: (version: number) => void
  editing: boolean
  onEdit: () => void
  /** Saves the person's text as a new version of their own; the version Cello wrote stays. */
  onSave: EditorProps['onSave']
  onCancel: () => void
  onClose: () => void
  /** Adds the thing to the open chat as a tile. Left out when there is no chat or the chat already holds it. */
  onAddToChat?: () => void
  /** Opens a new chat with the thing attached. */
  onUseInNewChat?: () => void
  error?: string | null
}

export function PanelView({ thing, versions, selected, onSelect, editing, onEdit, onSave, onCancel, onClose, onAddToChat, onUseInNewChat, error }: PanelViewProps) {
  const current = versions.find((v) => v.version === selected) ?? versions[0]
  const latest = versions[0]?.version ?? 0
  const field = EDITABLE_FIELD[thing.type]
  return (
    <aside aria-label={thing.title} className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <header className="flex items-start gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-label uppercase tracking-wide text-muted-foreground">{typeWord(thing.type)}</p>
          <h2 className="break-words text-body font-semibold text-foreground">{thing.title}</h2>
        </div>
        <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      {current && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-caption text-muted-foreground">
          <label className="flex items-center gap-1">
            <span className="sr-only">Version</span>
            <select value={current.version} onChange={(e) => onSelect(Number(e.target.value))} className="rounded-control border border-input bg-card px-1 py-0.5 text-caption text-foreground">
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  Version {v.version} of {latest}
                </option>
              ))}
            </select>
          </label>
          <span>{author(current.author)}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!current ? (
          <p className="text-caption text-muted-foreground">This has no versions yet.</p>
        ) : editing ? (
          <EditorStub markdown={field ? String(current.content[field] ?? '') : ''} versionLabel={`Version ${current.version}`} templateId={null} onSave={onSave} />
        ) : (
          <Markdown content={current.content_text} />
        )}
        {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
      </div>
      {current && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border p-3">
          {editing ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <>
              {field && selected === latest && (
                <Button size="sm" variant="outline" onClick={onEdit}>
                  Edit
                </Button>
              )}
              <CopyButton text={current.content_text} />
              {onAddToChat && (
                <Button size="sm" variant="outline" onClick={onAddToChat}>
                  Add to chat
                </Button>
              )}
              {onUseInNewChat && (
                <Button size="sm" variant="outline" onClick={onUseInNewChat}>
                  Use in a new chat
                </Button>
              )}
            </>
          )}
        </footer>
      )}
    </aside>
  )
}

export function SidePanel({ artifactId, onClose, onAddToChat, onUseInNewChat }: { artifactId: string; onClose: () => void; onAddToChat?: () => void; onUseInNewChat?: () => void }) {
  const [thing, setThing] = useState<PanelThing | null>(null)
  const [versions, setVersions] = useState<PanelVersion[]>([])
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`)
      if (!res.ok) throw new Error('not found')
      const body = (await res.json()) as { artifact: PanelThing; versions: PanelVersion[] }
      setThing(body.artifact)
      setVersions(body.versions)
      setSelected(body.versions[0]?.version ?? 0)
      setError(null)
    } catch {
      setError('Cello could not open this. It may have been removed.')
    }
  }
  useEffect(() => {
    setEditing(false)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId])

  if (!thing) return <aside className="p-3 text-caption text-muted-foreground">{error ?? 'Opening…'}</aside>
  const current = versions.find((v) => v.version === selected) ?? versions[0]
  const field = EDITABLE_FIELD[thing.type]

  return (
    <PanelView
      thing={thing}
      versions={versions}
      selected={current?.version ?? 0}
      onSelect={setSelected}
      editing={editing}
      error={error}
      onClose={onClose}
      onAddToChat={onAddToChat}
      onUseInNewChat={onUseInNewChat}
      onEdit={() => setEditing(true)}
      onCancel={() => setEditing(false)}
      onSave={async ({ markdown }) => {
        if (!field || !current) return { ok: false }
        const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: { ...current.content, [field]: markdown } }),
        })
        if (!res.ok) return { ok: false }
        setEditing(false)
        await load()
        return { ok: true, markdown, versionLabel: `Version ${current.version + 1}` }
      }}
    />
  )
}
