// The one reader. Every consumer of a stored resume (preview, PDF, DOCX, diff,
// the studio pages) goes through here, so no reader can bypass the conversion of
// a legacy row. Pure: no Supabase import, safe in client components.
//
//   content_json.resume valid  -> it
//   content_json.markdown      -> markdownToResume(markdown)       (legacy formatted rows)
//   content only               -> markdownToResume(infer(content)) (legacy plain and tailored rows)
//
// A converted row carries meta.cello.parsedFrom = 'legacy'.
// ponytail: no memo; cache content_json.resume on next save if a profile ever shows this.

import { textToResume } from './from-markdown'
import { resumeToMarkdown } from './render'
import { ResumeSchema, type NameContext, type Resume } from './schema'
import { getResumeMarkdown, getResumeTemplateId, type ResumeContentJson } from './types'

export function resolveResume(
  doc: { content: string; content_json: ResumeContentJson | null },
  ctx?: NameContext
): Resume {
  const stored = ResumeSchema.safeParse(doc.content_json?.resume)
  if (stored.success) return stored.data

  const resume = textToResume(getResumeMarkdown(doc.content_json) ?? doc.content ?? '', {
    ...ctx,
    parsedFrom: 'legacy',
  })
  const templateId = getResumeTemplateId(doc.content_json)
  if (templateId) resume.meta.cello.templateId = templateId
  return resume
}

/** Canonical fixed-level Markdown for any row, new or legacy. */
export function resolveResumeMarkdown(
  doc: { content: string; content_json: ResumeContentJson | null },
  ctx?: NameContext
): string {
  return resumeToMarkdown(resolveResume(doc, ctx))
}
