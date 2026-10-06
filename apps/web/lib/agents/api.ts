// The data behind the UI routes that are more than a call into another module: the Needs you
// list, an edit by the person, and a saved conversation read back for a page reload.

import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { BaseMessage } from '@langchain/core/messages'
import { isDemoProfile } from '@/lib/access/guardrails'
import { scoreTrace } from '@/lib/observability/langfuse'
import type { AdminClient } from '@/lib/harness/types'
import type { ApprovalRow, ApprovalStatus } from './approvals'
import { addVersion, editDistanceRatio, getArtifact, type ArtifactRow } from './artifacts'
import { toWire } from './sse'

// --- Needs you ----------------------------------------------------------------------

export interface ApprovalCard {
  approval: ApprovalRow
  artifact: { id: string; title: string; type: ArtifactRow['type']; version: number; preview: string } | null
}

const APPROVAL_COLUMNS =
  'id, user_id, conversation_id, thread_id, scheduled_task_id, action, artifact_id, artifact_version, payload_hash, target_table, target_id, status, decided_by, decided_at, executed_at, outcome, error, posted_at, idempotency_key, trace_id, created_at'

/** The person's approvals, newest first, each with a preview of the words it would send. */
export async function listApprovals(admin: AdminClient, userId: string, status: ApprovalStatus | 'all' = 'pending', limit = 50): Promise<ApprovalCard[]> {
  let q = admin.from('approvals').select(APPROVAL_COLUMNS).eq('user_id', userId)
  if (status !== 'all') q = q.eq('status', status)
  const { data } = await q.order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 100))
  const rows = (data as ApprovalRow[] | null) ?? []
  const cards: ApprovalCard[] = []
  for (const approval of rows) {
    const got = await getArtifact(admin, userId, approval.artifact_id, { version: approval.artifact_version })
    cards.push({
      approval,
      artifact: got ? { id: got.artifact.id, title: got.artifact.title, type: got.artifact.type, version: got.version.version, preview: got.version.content_text.slice(0, 600) } : null,
    })
  }
  return cards
}

// --- edits by the person ------------------------------------------------------------

export type EditResult = { ok: true; version: number } | { ok: false; status: number; error: string; fix: string }

/**
 * The person's own edit, saved as a new version. How far they moved the words from Cello's
 * draft is recorded on the draft's trace as "draft_edited": a draft they barely touched is
 * a good one, and one they rewrote is not.
 */
export async function editArtifact(admin: AdminClient, userId: string, id: string, content: unknown): Promise<EditResult> {
  const before = await getArtifact(admin, userId, id)
  if (!before) return { ok: false, status: 404, error: 'Not found', fix: 'Open the list of your documents and choose one from it.' }
  let version: number
  try {
    version = await addVersion(admin, { userId, artifactId: id, author: 'user', content })
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message.slice(0, 300) : 'Could not save', fix: 'Check the fields and try again.' }
  }
  const after = await getArtifact(admin, userId, id, { version })
  if (before.version.author === 'cello' && before.version.trace_id && after) {
    void scoreTrace(before.version.trace_id, 'draft_edited', editDistanceRatio(before.version.content_text, after.version.content_text))
  }
  return { ok: true, version }
}

// --- a conversation, read back ------------------------------------------------------

export interface SavedConversation {
  /** Shaped as the hook's `values`: the messages as it reads them. */
  values: { messages: unknown[] }
  /** A question Cello is waiting on, if any. A handover to a fresh request is not a question and is left out. */
  interrupts: { value: unknown }[]
}

/** The saved messages of a conversation, for initial values after a reload. The caller has checked ownership. */
export async function readSavedConversation(saver: BaseCheckpointSaver, threadId: string): Promise<SavedConversation> {
  const tuple = await saver.getTuple({ configurable: { thread_id: threadId } })
  const messages = ((tuple?.checkpoint.channel_values as { messages?: BaseMessage[] } | undefined)?.messages ?? []) as BaseMessage[]
  const interrupts: { value: unknown }[] = []
  for (const [, channel, value] of tuple?.pendingWrites ?? []) {
    if (channel !== '__interrupt__') continue
    for (const i of Array.isArray(value) ? value : [value]) {
      const v = (i as { value?: unknown } | null)?.value
      if ((v as { kind?: string } | undefined)?.kind !== 'slice') interrupts.push({ value: toWire(v) })
    }
  }
  return { values: { messages: messages.map((m) => toWire(m)) }, interrupts }
}

// --- who is asking ------------------------------------------------------------------

/** Whether this person's account is a demo. A profile that cannot be read counts as one: the demo rules only take things away. */
export async function isDemoUser(admin: AdminClient, userId: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('is_demo, demo_expires_at').eq('id', userId).maybeSingle()
  const row = data as { is_demo?: boolean | null; demo_expires_at?: string | null } | null
  return row ? isDemoProfile({ is_demo: row.is_demo ?? null, demo_expires_at: row.demo_expires_at ?? null }) : true
}
