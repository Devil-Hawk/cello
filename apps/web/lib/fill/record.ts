// What the fill routes keep: the field list of the form a session served (so a later report is read
// against the server's own kinds and categories), and one application_attempts row per try at sending.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DOORS } from '@/lib/pipeline/actors'
import { note } from '@/lib/pipeline/transition'
import type { FieldCategory, FieldKind } from './contract'
import type { allowedReadBack, ServerField } from './wire'

type Known = Pick<ServerField, 'key' | 'kind' | 'category'>

/** The line a manual fill's "filled" report writes. The sweeper's lease branch reads payload.phase = 'filled' to tell a form that was filled from one that was not. */
export const filledEvent = (appId: string, stamp: string, counts: { filled: number | null; total: number | null }) => ({
  kind: 'fill.reported' as const,
  actor: DOORS.extension.actor,
  channel: DOORS.extension.channel,
  sentence: 'Your browser filled the form.',
  idempotencyKey: `filled:${appId}:${stamp}`,
  payload: { phase: 'filled', filled: counts.filled, total: counts.total },
})

/** A line on the timeline that also holds the field list the session served. It moves nothing. */
export async function saveSessionFields(admin: SupabaseClient, userId: string, applicationId: string, fields: readonly ServerField[]): Promise<void> {
  const list: Known[] = fields.map((f) => ({ key: f.key, kind: f.kind, category: f.category }))
  const sig = createHash('sha256').update(list.map((f) => `${f.key}|${f.kind}|${f.category}`).join('\n')).digest('hex').slice(0, 24)
  await note(admin, userId, applicationId, {
    kind: 'fill.reported',
    actor: DOORS.extension.actor,
    channel: DOORS.extension.channel,
    sentence: 'Your browser read the form.',
    idempotencyKey: `fields:${applicationId}:${sig}`,
    payload: { phase: 'session', fields: list },
  })
}

/** The fields of the form the last session served, as the server classified them. Empty when none was served. */
export async function loadSessionFields(admin: SupabaseClient, userId: string, applicationId: string): Promise<Known[]> {
  const { data } = await admin
    .from('pipeline_events')
    .select('payload')
    .eq('user_id', userId)
    .eq('application_id', applicationId)
    .eq('kind', 'fill.reported')
    .eq('payload->>phase', 'session')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const list = (data as { payload?: { fields?: unknown } } | null)?.payload?.fields
  return Array.isArray(list) ? (list as { key: string; kind: FieldKind; category: FieldCategory }[]) : []
}

export interface AttemptInput {
  app: { id: string; user_id: string; job_id: string; posting_url_hash: string | null; jobs: { url: string; title: string; companies: { name: string } | null } | null }
  outcome: 'unconfirmed' | 'sent'
  sentBy: 'person' | 'cello'
  values?: ReturnType<typeof allowedReadBack>
  finalUrl?: string
  confirmationText?: string
  screenshot?: Buffer | null
  version?: string | null
}

/**
 * One row per try. A try that was submitted and not yet confirmed is updated when the site confirms it.
 * The values are the allowlist's: a sensitive field is {"answered_by_you": true}, never its value. Saved
 * after the move, so a failure here is logged and never undoes the timeline's line.
 */
export async function recordAttempt(admin: SupabaseClient, a: AttemptInput): Promise<string | null> {
  try {
    const open = await admin
      .from('application_attempts')
      .select('id, values_sent')
      .eq('user_id', a.app.user_id)
      .eq('application_id', a.app.id)
      .eq('provenance', 'browser_companion')
      .eq('attempt_outcome', 'unconfirmed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const prior = open.data as { id: string; values_sent: Record<string, unknown> | null } | null
    const values = a.values ? Object.fromEntries(a.values.map((v) => [v.key, v.entry])) : (prior?.values_sent ?? null)
    let host: string | null = null
    try {
      host = a.finalUrl ? new URL(a.finalUrl).hostname : null
    } catch {
      host = null
    }
    const fields: Record<string, unknown> = {
      attempt_outcome: a.outcome,
      verification_state: a.outcome === 'sent' ? 'system_confirmed' : 'unconfirmed',
      sent_by: a.sentBy,
      values_sent: values,
      updated_at: new Date().toISOString(),
      ...(a.finalUrl ? { final_url: a.finalUrl } : {}),
      ...(a.confirmationText ? { confirmation_text: a.confirmationText.slice(0, 2000) } : {}),
      ...(a.version ? { extension_version: a.version.slice(0, 40) } : {}),
    }
    let id = prior?.id ?? null
    if (id) {
      const u = await admin.from('application_attempts').update(fields).eq('id', id).eq('user_id', a.app.user_id)
      if (u.error) throw new Error(u.error.message)
    } else {
      const ins = await admin
        .from('application_attempts')
        .insert({
          ...fields,
          user_id: a.app.user_id,
          application_id: a.app.id,
          job_id: a.app.job_id,
          posting_url_hash: a.app.posting_url_hash,
          company_name: a.app.jobs?.companies?.name ?? null,
          title: a.app.jobs?.title ?? null,
          provenance: 'browser_companion',
          submitted_at: new Date().toISOString(),
          destination: host,
        })
        .select('id')
        .single()
      if (ins.error) throw new Error(ins.error.message)
      id = (ins.data as { id: string }).id
    }
    if (a.screenshot && id) {
      const path = `${a.app.user_id}/${id}.jpg`
      const up = await admin.storage.from('attempts').upload(path, a.screenshot, { contentType: 'image/jpeg', upsert: true })
      if (!up.error) await admin.from('application_attempts').update({ screenshot_path: path }).eq('id', id).eq('user_id', a.app.user_id)
    }
    return id
  } catch (e) {
    console.error('could not save the attempt', e instanceof Error ? e.message : e)
    return null
  }
}
