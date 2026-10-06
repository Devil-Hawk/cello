// Applications found in email. Mail from a verified employer that says "we received your application"
// never makes an application by itself: it waits here, and counts for nothing, until the person
// says it is theirs. Confirm makes the application real, adds the company the person did not follow
// (not followed: watching stays false), and writes an `applied` reaction so the role's history
// teaches the ranking.

import type { SupabaseClient } from '@supabase/supabase-js'
import { addByHand } from '@/lib/pipeline/add'

export interface FoundItem {
  /** An application already made (at a company the person follows), waiting for Confirm. */
  applicationId: string | null
  /** Or the mail that found it, when no company or application exists yet. */
  messageId: string | null
  company: string
  title: string | null
  at: string
}

export async function listFound(admin: SupabaseClient, userId: string): Promise<FoundItem[]> {
  const [apps, mail] = await Promise.all([
    admin
      .from('applications')
      .select('id, applied_at, created_at, jobs(title, companies(name))')
      .eq('user_id', userId)
      .eq('found_state', 'to_confirm')
      .order('created_at', { ascending: false })
      .limit(100),
    admin
      .from('messages')
      .select('id, sent_at, job_title, company_directory(name)')
      .eq('user_id', userId)
      .is('application_id', null)
      .eq('kind', 'applied')
      .eq('trust', 'proven')
      .not('employer_id', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(100),
  ])
  const out: FoundItem[] = []
  for (const a of (apps.data ?? []) as unknown as { id: string; applied_at: string | null; created_at: string; jobs: { title: string; companies: { name: string } | null } | null }[]) {
    out.push({ applicationId: a.id, messageId: null, company: a.jobs?.companies?.name ?? '', title: a.jobs?.title ?? null, at: a.applied_at ?? a.created_at })
  }
  for (const m of (mail.data ?? []) as unknown as { id: string; sent_at: string; job_title: string | null; company_directory: { name: string } | null }[]) {
    out.push({ applicationId: null, messageId: m.id, company: m.company_directory?.name ?? '', title: m.job_title, at: m.sent_at })
  }
  return out
}

export type ConfirmResult = { ok: true; applicationId: string } | { ok: false; sentence: string }

/**
 * "applied" in the person's own taste history. The table belongs to the scoring package (K8a); where it is
 * not deployed yet this does nothing and Confirm still succeeds.
 * ponytail: history as applied reactions; a separate history input if K15's blend needs counts apart.
 */
async function appliedReaction(admin: SupabaseClient, userId: string, applicationId: string): Promise<void> {
  try {
    const { data } = await admin.from('applications').select('job_id, jobs(title, location, companies(name))').eq('id', applicationId).eq('user_id', userId).maybeSingle()
    const a = data as unknown as { job_id: string; jobs: { title: string; location: string | null; companies: { name: string } | null } | null } | null
    if (!a) return
    await admin.from('role_reactions').upsert(
      { user_id: userId, job_id: a.job_id, reaction: 'applied', reason: null, surface: 'applications', job_title: a.jobs?.title ?? '', company_name: a.jobs?.companies?.name ?? '', job_location: a.jobs?.location ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,job_id' },
    )
  } catch {
    // role_reactions is not there yet
  }
}

export async function confirmFound(admin: SupabaseClient, userId: string, input: { applicationId?: string | null; messageId?: string | null }): Promise<ConfirmResult> {
  let applicationId = input.applicationId ?? null
  if (applicationId) {
    const { data } = await admin
      .from('applications')
      .update({ found_state: 'confirmed' })
      .eq('id', applicationId)
      .eq('user_id', userId)
      .eq('found_state', 'to_confirm')
      .select('id')
      .maybeSingle()
    if (!data) return { ok: false, sentence: 'That one is gone or already confirmed.' }
  } else if (input.messageId) {
    const { data } = await admin
      .from('messages')
      .select('id, sent_at, job_title, employer_id, company_directory(name, domain, careers_url)')
      .eq('id', input.messageId)
      .eq('user_id', userId)
      .is('application_id', null)
      .eq('kind', 'applied')
      .eq('trust', 'proven')
      .maybeSingle()
    const m = data as unknown as { id: string; sent_at: string; job_title: string | null; employer_id: string | null; company_directory: { name: string; domain: string | null; careers_url: string | null } | null } | null
    if (!m || !m.employer_id || !m.company_directory) return { ok: false, sentence: 'That one is gone or already confirmed.' }
    if (!m.job_title) return { ok: false, sentence: 'The mail did not name the role. Add the application yourself.' }
    const made = await addByHand(
      admin,
      userId,
      { company: m.company_directory.name, title: m.job_title, url: m.company_directory.careers_url, stage: 'applied', appliedAt: m.sent_at, employerId: m.employer_id, domain: m.company_directory.domain },
      'gmail_sync',
    )
    if (!made.ok) return { ok: false, sentence: made.sentence }
    applicationId = made.applicationId
    await admin.from('applications').update({ found_state: 'confirmed' }).eq('id', applicationId).eq('user_id', userId)
    await admin.from('messages').update({ application_id: applicationId }).eq('id', m.id).eq('user_id', userId)
  } else {
    return { ok: false, sentence: 'Say which one to confirm.' }
  }
  await appliedReaction(admin, userId, applicationId)
  return { ok: true, applicationId }
}
