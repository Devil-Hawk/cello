'use client'

// lane-stub: PG8a editor
// A plain text area that keeps the editor's contract (EditorProps from resume's editor types): Markdown in, a save that
// appends a version and hands back the canonical text and its name, or fails and leaves the person's text in the box.
// Deleted when PG8a's editor component is on main; the side panel then mounts that one with the same props.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { EditorProps } from '@/components/resume/editor/types'

export function EditorStub({ markdown, versionLabel, onSave, readOnly, className }: EditorProps) {
  const [draft, setDraft] = useState(markdown)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className={className}>
      <textarea aria-label="Edit this version" value={draft} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} rows={16} className="w-full rounded-control border border-input bg-card p-2 text-body text-foreground" />
      {failed && <p className="mt-2 text-caption text-destructive">Cello could not save that. Your text is still here.</p>}
      {!readOnly && (
        <Button
          size="sm"
          className="mt-2"
          disabled={saving || !draft.trim()}
          onClick={async () => {
            setSaving(true)
            setFailed(false)
            // A save appends a version after {versionLabel}; it never overwrites the one shown.
            const out = await onSave({ markdown: draft, templateId: null })
            setSaving(false)
            if (out.ok) setDraft(out.markdown)
            else setFailed(true)
          }}
          aria-label={`Save as my version, after ${versionLabel}`}
        >
          Save as my version
        </Button>
      )}
    </div>
  )
}
