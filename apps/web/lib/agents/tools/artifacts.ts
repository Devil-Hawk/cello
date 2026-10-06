// create_artifact and update_artifact: writing a document, and revising one.
//
// Both run the Writer inline, so the draft is checked by the Reviewer before it is saved
// and is never sent. For many documents the model
// calls create_artifact once per document: one chain per document, never split.

import { z } from 'zod'
import { getArtifactRow } from '../artifacts'
import { runWriter } from '@/lib/workflows/writer'
import { defineTool, keyFor, toolFix, writeFields, type CelloTool } from './common'

export const createArtifactTool = defineTool({
  name: 'create_artifact',
  description:
    'Write one document for the person and save it as a draft: a tailored resume, a cover letter, an outreach email, a follow-up to an email already sent, a reply to a message the person received, or a note. ' +
    'It is checked against their resume before it is saved and it is never sent. Pass job_id for a role and contact_id for an email; ' +
    'get both from find_roles and people. For several documents call it once for each. To send an email afterwards use request_approval.',
  schema: z.object({
    type: z.enum(['resume', 'cover_letter', 'message', 'follow_up', 'reply', 'note']).describe('Which document. follow_up is a single note after an email already sent. reply answers the message in reply_to.'),
    reply_to: z.string().min(1).max(4000).optional().describe('For a reply: the message being answered, as the person received it.'),
    job_id: z.string().min(1).optional().describe('The role the document is for, from find_roles.'),
    contact_id: z.string().min(1).optional().describe('Who an email is for, from people.'),
    instructions: z.string().max(600).optional().describe('Anything the person asked for, in their words, for example "keep it under 100 words".'),
    ...writeFields,
  }),
  kind: 'write',
  untrusted: false,
  mcp: true,
  async handler(ctx, a, meta) {
    const key = keyFor(ctx, meta, a.idempotency_key)
    const out = await runWriter({ ctx }, { type: a.type, job_id: a.job_id, contact_id: a.contact_id, reply_to: a.reply_to, instructions: a.instructions, idempotency_key: key }, meta.config)
    return out.status === 'failed' ? toolFix(out.error ?? 'Could not write it.', out.fix ?? 'Try again.') : out
  },
}) satisfies CelloTool

export const updateArtifactTool = defineTool({
  name: 'update_artifact',
  description:
    'Revise a saved draft. Pass the artifact id and the change in the person\'s words, for example "make it shorter" or "mention the billing project". ' +
    'It saves a new version and the old one stays. Works on resumes, cover letters and emails. It is checked again and is never sent.',
  schema: z.object({
    id: z.string().min(1).describe('The artifact id from create_artifact.'),
    change: z.string().min(3).max(600).describe('What to change, in the person\'s words.'),
    ...writeFields,
  }),
  kind: 'write',
  untrusted: false,
  mcp: true,
  async handler(ctx, a, meta) {
    const row = await getArtifactRow(ctx.admin, ctx.userId, a.id)
    if (!row) return toolFix(`No artifact with id ${a.id}.`, 'Use an id returned by create_artifact.')
    if (!['resume', 'cover_letter', 'message'].includes(row.type)) {
      return toolFix(`A ${row.type.replace('_', ' ')} is revised by writing it again.`, 'Call research for a dossier.')
    }
    const out = await runWriter(
      { ctx },
      { type: row.type as 'resume' | 'cover_letter' | 'message', artifact_id: row.id, instructions: a.change, idempotency_key: keyFor(ctx, meta, a.idempotency_key) },
      meta.config
    )
    return out.status === 'failed' ? toolFix(out.error ?? 'Could not revise it.', out.fix ?? 'Try again.') : out
  },
}) satisfies CelloTool
