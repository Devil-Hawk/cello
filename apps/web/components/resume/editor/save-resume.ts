// The one saver for the resume pages: append an edited version to a bucket
// (jobId null is the base resume) and map the reply to the editor's save result.
// Chat saves through its own command call and does not import this file.

import type { EditorSaveResult } from './types'

export async function saveResumeVersion(args: {
  jobId: string | null
  markdown: string
  templateId: string | null
}): Promise<EditorSaveResult> {
  try {
    const res = await fetch('/api/resume/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Markdown and template only: the server derives the plain text an employer's parser reads.
      body: JSON.stringify({ action: 'save', jobId: args.jobId, markdown: args.markdown, templateId: args.templateId ?? undefined, source: 'edited' }),
    })
    const data = (await res.json().catch(() => null)) as { document?: { version?: number }; markdown?: string } | null
    if (!res.ok || typeof data?.document?.version !== 'number' || typeof data.markdown !== 'string') return { ok: false }
    return { ok: true, markdown: data.markdown, versionLabel: `Version ${data.document.version}` }
  } catch {
    return { ok: false }
  }
}
