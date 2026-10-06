// The resume editor's contract. Chat's side panel and Profile both mount the
// editor through these props. The shape does not change; anything more goes
// in a new optional field.

export type EditorMode = 'edit' | 'preview' | 'diff'

export interface EditorCompare {
  label: string
  markdown: string
}

/** A save either hands back the canonical Markdown and the new version's name, or fails. */
export type EditorSaveResult = { ok: true; markdown: string; versionLabel: string } | { ok: false }

export interface EditorProps {
  /** Canonical Markdown of the version shown. */
  markdown: string
  /** "Version 3". Never a file name. */
  versionLabel: string
  /** A resume's template id. Null for a letter or message: no picker, plain preview. */
  templateId: string | null
  /** Diff is offered only with one. */
  compare?: EditorCompare | null
  /** Saving appends a version. It never overwrites the one shown. */
  onSave: (draft: { markdown: string; templateId: string | null }) => Promise<EditorSaveResult>
  readOnly?: boolean
  defaultMode?: EditorMode
  className?: string
}
