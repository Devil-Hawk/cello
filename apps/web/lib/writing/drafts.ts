// The one door for the text of an application draft (K17). A cover letter and the answers drafted
// for a form are made things: each is an artifact with numbered versions, and every writer of that
// text calls this first, then writes the status machine's row (application_drafts) as before.
//
// One artifact per (person, role, kind): a later save adds a version, and a save of the same text
// adds nothing, so a retry or a second route does not pile up versions.

import { addVersion, createArtifact, getArtifact, renderMarkdown, type ArtifactRow } from '../agents/artifacts'
import type { AdminClient } from '../harness/types'

export type DraftTextInput =
  | { userId: string; jobId: string; field: 'cover_letter'; text: string; author?: 'user' | 'cello' }
  | { userId: string; jobId: string; field: 'answers'; answers: unknown; author?: 'user' | 'cello' }

export interface DraftTextRef {
  artifactId: string
  version: number
  /** False when the text was already the latest version. */
  changed: boolean
}

export async function saveDraftText(admin: AdminClient, input: DraftTextInput): Promise<DraftTextRef> {
  const type = input.field === 'cover_letter' ? 'cover_letter' : 'answers'
  const content = input.field === 'cover_letter' ? { text: input.text } : { answers: input.answers }
  const author = input.author ?? 'cello'
  const text = renderMarkdown(type, content)

  const { data } = await admin
    .from('artifacts')
    .select('id, current_version')
    .eq('user_id', input.userId)
    .eq('type', type)
    .eq('job_id', input.jobId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const existing = data as Pick<ArtifactRow, 'id' | 'current_version'> | null

  if (!existing) {
    const { data: job } = await admin.from('jobs').select('title').eq('id', input.jobId).maybeSingle()
    const title = `${type === 'cover_letter' ? 'Cover letter' : 'Answers'} for ${(job as { title?: string } | null)?.title ?? 'a role'}`
    const ref = await createArtifact(admin, { userId: input.userId, type, title, content, author, jobId: input.jobId, idempotencyKey: `draft:${type}:${input.jobId}` })
    return { artifactId: ref.id, version: ref.version, changed: true }
  }
  const latest = await getArtifact(admin, input.userId, existing.id)
  if (latest && latest.version.content_text === text) return { artifactId: existing.id, version: latest.version.version, changed: false }
  const version = await addVersion(admin, { userId: input.userId, artifactId: existing.id, author, content })
  return { artifactId: existing.id, version, changed: true }
}
