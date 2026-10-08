// What the groups of the record read, once per role: the person's application for it, its timeline and the newest
// mail about it. Read with the person's own session (row level security keeps it to their rows); nothing is
// counted or worded by a model.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

export interface AppRecord {
  id: string
  stage: string
  state: string | null
  step: string | null
  needs_reason: string | null
  needs_detail: Record<string, unknown> | null
  applied_at: string | null
  closed_reason: string | null
  interview_at: string | null
  instruction: string | null
  notes: string | null
  jobs: { title: string; url: string | null; companies: { name: string } | null } | null
}

export interface TimelineEvent {
  id: string
  kind: string
  actor: string
  actor_label: string | null
  channel: string | null
  step: string | null
  sentence: string
  from_state: string | null
  to_state: string | null
  trust: string
  cost_usd: number | null
  model_calls: number | null
  free_model: boolean | null
  created_at: string
}

export interface LastMail {
  id: string
  kind: string
  sent_at: string
  from: string | null
}

export interface AppBundle {
  app: AppRecord
  timeline: TimelineEvent[]
  mail: LastMail | null
}

const db = () => createClient() as unknown as SupabaseClient

/** One read of everything the Application group shows. Null when the person has no application for the role. */
export async function loadApp(jobId: string): Promise<AppBundle | null> {
  const client = db()
  const { data } = await client
    .from('applications')
    .select('id, stage, state, step, needs_reason, needs_detail, applied_at, closed_reason, interview_at, instruction, notes, jobs(title, url, companies(name))')
    .eq('job_id', jobId)
    .maybeSingle()
  const app = data as unknown as AppRecord | null
  if (!app) return null
  const [events, mail] = await Promise.all([
    client
      .from('pipeline_events')
      .select('id, kind, actor, actor_label, channel, step, sentence, from_state, to_state, trust, cost_usd, model_calls, free_model, created_at')
      .eq('application_id', app.id)
      .order('created_at', { ascending: false })
      .limit(100),
    client.from('messages').select('id, kind, sent_at, from_domain').eq('application_id', app.id).eq('direction', 'in').order('sent_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  const m = mail.data as { id: string; kind: string; sent_at: string; from_domain: string | null } | null
  return { app, timeline: (events.data as TimelineEvent[] | null) ?? [], mail: m ? { id: m.id, kind: m.kind, sent_at: m.sent_at, from: m.from_domain } : null }
}

/** A move the person makes, through the pipeline's own route. Throws the sentence the server gave. */
export async function act(applicationId: string, action: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`/api/applications/${applicationId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(b.error ?? 'Could not do that. Nothing changed.')
  }
}

/** The person's own note, saved on the row they own. */
export async function saveNotes(applicationId: string, notes: string | null): Promise<void> {
  const { error } = await db().from('applications').update({ notes }).eq('id', applicationId)
  if (error) throw new Error('Could not save the note. Nothing changed.')
}
