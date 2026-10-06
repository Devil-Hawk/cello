// The draft routes' door onto the Writer. A page button and a chat ask run the same graph
// (write, check once, save as a message artifact), so both make the same version and the same
// trace. The route then queues that version for approval with insertOutreach.
//
// The Writer's review is shaped here as the OutreachReview the routes and writeReviewVerdicts
// already read, so the card, the verdict rows and the response keep their shape.

import { getArtifact } from '../agents/artifacts'
import { newDeadline, type AgentContext } from '../agents/context'
import type { OutreachReview } from '../graph/verify/outreach-review'
import type { AdminClient } from '../harness/types'
import { loadApiKeys } from '../harness/keys'
import { traceRefFor } from '../trace/spans'
import { runWriter, type WriterBrief, type WriterResult } from '../workflows/writer'

export interface WrittenMessage {
  artifactId: string
  artifactVersion: number
  review: OutreachReview
}

export type WriteMessageResult = { ok: true; written: WrittenMessage } | { ok: false; error: string; fix?: string }

/** The Writer's review as the route-facing one. A reader that could not run is never shown as a pass. */
export function asOutreachReview(out: WriterResult, subject: string, body: string): OutreachReview {
  const review = out.review
  const checks = (review?.checks ?? []).map((c) => ({ id: c.name, ok: c.ok, message: c.detail ?? c.name }))
  const judge = review?.judge
  // ponytail: the refusal is read off the reviewer's sentence; give ReviewResult.judge a typed reason when it next changes.
  const refused = judge?.status === 'skipped' ? (/^No key/.test(judge.reason ?? '') ? 'missing-key' : /^Budget/.test(judge.reason ?? '') ? 'budget-cap' : undefined) : undefined
  return {
    subject,
    body,
    tokensUsed: 0,
    source: out.used_llm === false ? 'template' : 'model',
    templateReason: out.used_llm === false ? (out.template_reason as OutreachReview['templateReason']) : undefined,
    verdicts:
      judge?.status === 'passed' || judge?.status === 'failed'
        ? [{ name: 'groundedness', verdict: judge.status === 'passed' ? 'pass' : 'fail', score: judge.status === 'passed' ? 1 : 0, threshold: 1, n: 0, summary: judge.status === 'passed' ? 'A second reader found every statement supported.' : (review?.issues.find((i) => /second reader|Remove or rewrite/.test(i)) ?? 'A second reader found unsupported statements.') } as OutreachReview['verdicts'][number]]
        : [],
    checks: { ok: checks.every((c) => c.ok), checks } as OutreachReview['checks'],
    failed: !review?.passed,
    judgeUnavailable: judge?.status === 'skipped' && !refused,
    judgeRefused: refused,
  }
}

export async function writeMessage(
  admin: AdminClient,
  user: { id: string; email: string },
  brief: Pick<WriterBrief, 'type' | 'job_id' | 'contact_id' | 'instructions'>
): Promise<WriteMessageResult> {
  const apiKeys = await loadApiKeys(admin, user.id)
  const ctx: AgentContext = {
    admin,
    userId: user.id,
    userEmail: user.email,
    apiKeys,
    isDemo: apiKeys.isDemo !== false,
    threadId: '',
    conversationId: null,
    autonomy: 'ask',
    traceId: traceRefFor()?.trace_id ?? '',
    deadlineAt: newDeadline(),
  }
  const out = await runWriter({ ctx }, brief)
  if (out.status === 'failed' || !out.artifact_id || !out.version) return { ok: false, error: out.error ?? 'The draft could not be written.', fix: out.fix }
  const saved = await getArtifact(admin, user.id, out.artifact_id, { version: out.version })
  const content = saved?.version.content as { subject?: string; body?: string } | undefined
  if (!content?.subject || !content.body) return { ok: false, error: 'The draft was saved without its text.' }
  return { ok: true, written: { artifactId: out.artifact_id, artifactVersion: out.version, review: asOutreachReview(out, content.subject, content.body) } }
}

/** The artifact made for a draft that never reached the queue is dropped, as insertOutreach does for its own. */
export async function discardMessage(admin: AdminClient, userId: string, artifactId: string): Promise<void> {
  try {
    await admin.from('artifacts').delete().eq('id', artifactId).eq('user_id', userId)
  } catch {
    // An orphan artifact is harmless, and the error that got us here is the one worth raising.
  }
}
