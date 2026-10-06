// lane-stub: K17 versions
// Reads every saved resume version from resume_documents until K17's base resume and made things
// live in `artifacts`; K17 deletes this file and Profile reads them through documents.get.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { VersionRow } from '@/components/profile/versions'
import type { ResumeDocument } from '@/lib/resume/types'

type Named = { name?: string | null } | { name?: string | null }[] | null | undefined
const one = <T>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null))
const companyOf = (job: { companies?: Named } | null): string | null => one(job?.companies)?.name ?? null

/** Every version, newest first: its role and company by embed, and the application that sent it. */
export async function listAllVersions(supabase: SupabaseClient, userId: string): Promise<VersionRow[]> {
  const [docs, drafts] = await Promise.all([
    supabase
      .from('resume_documents')
      .select('*, jobs(title, companies(name))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase
      .from('application_drafts')
      .select('resume_document_id, submitted_at, updated_at, jobs(companies(name))')
      .eq('user_id', userId)
      .eq('status', 'submitted')
      .not('resume_document_id', 'is', null),
  ])
  if (docs.error) throw new Error(docs.error.message)

  const sent = new Map<string, { at: string; company: string | null }>()
  for (const d of (drafts.data ?? []) as unknown as {
    resume_document_id: string
    submitted_at: string | null
    updated_at: string
    jobs: { companies?: Named } | { companies?: Named }[] | null
  }[]) {
    sent.set(d.resume_document_id, { at: d.submitted_at ?? d.updated_at, company: companyOf(one(d.jobs)) })
  }

  return ((docs.data ?? []) as unknown as (ResumeDocument & { jobs?: { title: string; companies?: Named } | { title: string; companies?: Named }[] | null })[]).map(
    ({ jobs, ...doc }) => {
      const job = one(jobs)
      return { ...doc, role: job ? { title: job.title, company: companyOf(job) } : null, sent: sent.get(doc.id) ?? null }
    }
  )
}
