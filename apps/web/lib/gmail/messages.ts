// What is stored about a piece of mail: who, when, a short subject and the first lines, and how far
// to believe it. Bodies are never stored. Service role only; the session reads its own rows.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Trust } from '@/lib/pipeline/types'
import type { ApplicationStatus } from './types'
import type { HeaderVerdict } from './trust'

export type MessageKind = 'applied' | 'rejection' | 'interview' | 'offer' | 'recruiter' | 'reply' | 'other'

export function kindOfStatus(status: ApplicationStatus, recruiter = false): MessageKind {
  switch (status) {
    case 'applied':
      return 'applied'
    case 'rejected':
      return 'rejection'
    case 'screen':
    case 'interview':
      return 'interview'
    case 'offer':
    case 'accepted':
      return 'offer'
    default:
      return recruiter ? 'recruiter' : 'other'
  }
}

/** The first six non-empty lines, at most 600 characters. Quoted replies and long links are cut first. */
export function excerptOf(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('>'))
    .slice(0, 6)
    .join('\n')
    .replace(/https?:\/\/\S{60,}/g, '[link]')
    .slice(0, 600)
}

export interface MessageRow {
  userId: string
  gmailMessageId: string
  threadId: string | null
  applicationId: string | null
  contactId: string | null
  sentAt: string
  fromDomain: string | null
  subject: string
  body: string
  kind: MessageKind
  origin: 'code' | 'model'
  prov: Record<string, unknown> | null
  trust: Trust
  verdict: HeaderVerdict
  employerId: string | null
  employerOrigin: 'code' | 'model' | null
  jobTitle: string | null
}

export async function saveMessage(admin: SupabaseClient, m: MessageRow): Promise<void> {
  try {
    await write(admin, m)
  } catch (e) {
    // A message that cannot be stored must not stop the read: the sync keeps going.
    console.error('[inbox] message not stored:', e instanceof Error ? e.name : 'error')
  }
}

async function write(admin: SupabaseClient, m: MessageRow): Promise<void> {
  const { error } = await admin.from('messages').upsert(
    {
      user_id: m.userId,
      gmail_message_id: m.gmailMessageId,
      thread_id: m.threadId,
      application_id: m.applicationId,
      contact_id: m.contactId,
      direction: 'in',
      sent_at: m.sentAt,
      from_domain: m.fromDomain,
      subject: m.subject.slice(0, 200),
      excerpt: excerptOf(m.body),
      kind: m.kind,
      origin: m.origin,
      prov: m.prov,
      trust: m.trust,
      header_verdict: m.verdict,
      employer_id: m.employerId,
      employer_origin: m.employerOrigin,
      employer_prov: m.employerId ? { rule: m.employerOrigin === 'code' ? 'sender domain is the verified employer' : 'named in the mail' } : null,
      job_title: m.jobTitle ? m.jobTitle.slice(0, 200) : null,
    },
    { onConflict: 'user_id,gmail_message_id' },
  )
  if (error) console.error('[inbox] message not stored:', error.code ?? 'error')
}

/** A directory employer the verifier passed, by its domain. */
export async function verifiedEmployer(admin: SupabaseClient, domain: string | null): Promise<{ id: string; name: string; domain: string; careers_url: string | null } | null> {
  if (!domain) return null
  try {
    const { data } = await admin
      .from('company_directory')
      .select('id, name, domain, careers_url')
      .eq('domain', domain.toLowerCase())
      .not('verified_at', 'is', null)
      .limit(1)
      .maybeSingle()
    return (data as { id: string; name: string; domain: string; careers_url: string | null } | null) ?? null
  } catch {
    return null
  }
}
