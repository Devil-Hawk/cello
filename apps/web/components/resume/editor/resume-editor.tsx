'use client'

// The resume editor Chat's side panel and Profile both mount: the Markdown
// workspace plus one way to save. Saving appends a version through `onSave`;
// it never overwrites the version shown, and a failed save keeps the text.
// Mount it with a `key` per version so opening another version starts clean.

import { useEffect, useReducer } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ResumeWorkspace } from '../resume-workspace'
import type { EditorProps } from './types'

export interface EditorState {
  markdown: string
  templateId: string | null
  /** What was last saved (or opened): `dirty` is the difference. */
  savedMarkdown: string
  savedTemplateId: string | null
  versionLabel: string
  status: 'idle' | 'saving' | 'failed' | 'saved'
}

export type EditorAction =
  | { type: 'edit'; markdown: string }
  | { type: 'template'; templateId: string }
  | { type: 'saving' }
  | { type: 'failed' }
  /** `sent` is the draft that went to the server; the rest is what it stored. */
  | { type: 'saved'; sent: { markdown: string; templateId: string | null }; markdown: string; versionLabel: string }

export function initEditor(p: Pick<EditorProps, 'markdown' | 'templateId' | 'versionLabel'>): EditorState {
  return {
    markdown: p.markdown,
    templateId: p.templateId,
    savedMarkdown: p.markdown,
    savedTemplateId: p.templateId,
    versionLabel: p.versionLabel,
    status: 'idle',
  }
}

export const isDirty = (s: EditorState) => s.markdown !== s.savedMarkdown || s.templateId !== s.savedTemplateId

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'edit':
      return { ...s, markdown: a.markdown, status: s.status === 'saving' ? s.status : 'idle' }
    case 'template':
      return { ...s, templateId: a.templateId, status: s.status === 'saving' ? s.status : 'idle' }
    case 'saving':
      return { ...s, status: 'saving' }
    case 'failed':
      // The buffer stays exactly as typed.
      return { ...s, status: 'failed' }
    case 'saved':
      // The server hands back the canonical Markdown: show it only if nothing was typed
      // since the draft left. Otherwise keep the buffer, which stays dirty.
      return {
        ...s,
        markdown: s.markdown === a.sent.markdown ? a.markdown : s.markdown,
        savedMarkdown: a.markdown,
        savedTemplateId: a.sent.templateId,
        versionLabel: a.versionLabel,
        status: 'saved',
      }
  }
}

export function ResumeEditor({
  markdown,
  versionLabel,
  templateId,
  compare = null,
  onSave,
  readOnly = false,
  defaultMode = 'edit',
  className,
}: EditorProps) {
  const [state, dispatch] = useReducer(editorReducer, { markdown, templateId, versionLabel }, initEditor)
  const dirty = isDirty(state)
  const saving = state.status === 'saving'

  // Leaving with unsaved text would lose it.
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  async function save() {
    if (!dirty || saving || readOnly) return
    dispatch({ type: 'saving' })
    try {
      const sent = { markdown: state.markdown, templateId: state.templateId }
      const result = await onSave(sent)
      dispatch(result.ok ? { type: 'saved', sent, markdown: result.markdown, versionLabel: result.versionLabel } : { type: 'failed' })
    } catch {
      dispatch({ type: 'failed' })
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-caption text-muted-foreground">
            {state.versionLabel}
            {dirty ? ', not saved yet' : ''}
          </p>
          {/* ponytail: Button until PG0's Key is on the base; swap at the rebase */}
          <Button
            type="button"
            className="min-h-11"
            disabled={!dirty || saving}
            aria-keyshortcuts="Control+S Meta+S"
            title="Save as a new version (Ctrl+S)"
            onClick={save}
          >
            {saving ? 'Saving' : 'Save as a new version'}
          </Button>
        </div>
      )}

      <div role="status" aria-live="polite" className="text-caption">
        {state.status === 'saved' && !dirty && (
          <p className="text-muted-foreground">Saved as {state.versionLabel}.</p>
        )}
      </div>
      {state.status === 'failed' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-caption text-destructive">
          <p>Could not save. Your last saved version is unchanged.</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={save}>
            Try again
          </Button>
        </div>
      )}

      <ResumeWorkspace
        markdown={state.markdown}
        onMarkdownChange={(m) => dispatch({ type: 'edit', markdown: m })}
        templateId={state.templateId}
        onTemplateChange={(t) => dispatch({ type: 'template', templateId: t })}
        onSave={readOnly ? undefined : save}
        compareMarkdown={compare?.markdown ?? null}
        compareLabel={compare?.label}
        currentLabel={state.versionLabel}
        defaultMode={defaultMode}
        readOnly={readOnly}
      />
    </div>
  )
}
