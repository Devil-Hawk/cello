// documents.draft: the Writer makes a document for a role or a person (a reply, a follow-up, a note, a cover letter,
// a tailored resume). It saves a draft artifact and never sends: sending is the person's click, elsewhere.

import { z } from 'zod'
import { getArtifact } from '@/lib/agents/artifacts'
import { newDeadline, type AgentContext } from '@/lib/agents/context'
import { madeThing, ThingSchema } from '@/lib/chat/things'
import { withWorker } from '@/lib/chat/workers'
import { loadApiKeys } from '@/lib/harness/keys'
import { runWriter } from '@/lib/workflows/writer'
import { CommandRefusal, defineCommand, type AnyCommand } from '../define'
import { codeText, untrustedText } from '../text'

export const documentsDraft = defineCommand({
  id: 'documents.draft',
  label: 'Write a draft',
  input: z.strictObject({
    type: z.enum(['reply', 'message', 'follow_up', 'note', 'cover_letter', 'resume']),
    job_id: z.string().max(100).optional(),
    contact_id: z.string().max(100).optional(),
    instructions: z.string().max(600).optional(),
  }),
  output: z.object({ sentence: codeText(300), artifact_id: codeText(100), version: z.number().int(), title: untrustedText(200), preview: untrustedText(600), things: z.array(ThingSchema).max(1) }),
  callers: ['chat'],
  kind: 'wf',
  sends: false,
  egress: 'record',
  limits: { bucket: 'drafts' },
  measure: 'S5',
  async run(ctx, input) {
    const db = ctx.admin()
    // A reply answers the contact's newest inbound message, read from the stored row and handed over as data.
    let replyTo: string | undefined
    if (input.type === 'reply') {
      if (!input.contact_id) throw new CommandRefusal(400, 'A reply needs the person it answers.', 'input')
      const { data } = await db.from('messages').select('excerpt, subject, sent_at').eq('user_id', ctx.userId).eq('contact_id', input.contact_id).eq('direction', 'in').order('sent_at', { ascending: false }).limit(1)
      const m = ((data as { excerpt: string | null; subject: string; sent_at: string }[] | null) ?? [])[0]
      if (!m) throw new CommandRefusal(404, 'There is no stored message from that person to answer.', 'not_found')
      replyTo = [m.subject && `Subject: ${m.subject}`, m.excerpt].filter(Boolean).join('\n')
    }
    const apiKeys = await loadApiKeys(db, ctx.userId)
    const agent: AgentContext = {
      admin: db,
      userId: ctx.userId,
      userEmail: '',
      apiKeys,
      isDemo: apiKeys.isDemo !== false,
      threadId: ctx.chat?.chatId ?? '',
      conversationId: null,
      autonomy: 'ask',
      traceId: '',
      signal: ctx.signal,
      deadlineAt: newDeadline(),
    }
    const out = ctx.chat
      ? await withWorker({ db, userId: ctx.userId, threadId: ctx.chat.chatId, chatId: ctx.chat.chatId, turnId: ctx.chat.turnId }, { command: 'documents.draft', title: `Writing a ${input.type.replace('_', ' ')}` }, () => runWriter({ ctx: agent }, { type: input.type, job_id: input.job_id, contact_id: input.contact_id, instructions: input.instructions, reply_to: replyTo }))
      : await runWriter({ ctx: agent }, { type: input.type, job_id: input.job_id, contact_id: input.contact_id, instructions: input.instructions, reply_to: replyTo })
    if (out.status === 'failed' || !out.artifact_id || !out.version) throw new CommandRefusal(502, out.error ?? 'The draft could not be written.', 'failed')
    if (ctx.chat) await db.from('artifacts').update({ chat_turn_id: ctx.chat.turnId }).eq('id', out.artifact_id).eq('user_id', ctx.userId)
    const saved = await getArtifact(db, ctx.userId, out.artifact_id, { version: out.version })
    const title = out.title ?? saved?.artifact.title ?? 'Draft'
    const preview = (out.preview ?? saved?.version.content_text ?? '').slice(0, 600)
    return {
      sentence: `Wrote version ${out.version} of ${title}. Nothing was sent.`,
      artifact_id: out.artifact_id,
      version: out.version,
      title,
      preview,
      things: [madeThing(out.artifact_id, title, [saved?.version.content_text.slice(0, 1000) ?? preview])],
    }
  },
})

export const workflowsCommands: AnyCommand[] = [documentsDraft]
