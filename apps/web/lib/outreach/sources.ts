// Everything a draft is written from and checked against, loaded once so the
// draft route, the follow-up route and the manual check all see the same
// sources. The job post and the contact's own history are read here, the
// company research as numbered facts, and the sender's identity from the
// profile. Reads go through the signed-in client so row-level security applies,
// except history and research, which read with the service role scoped by user.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminClient } from '@/lib/harness/types'
import type { OutreachDraftInput, SourceLine } from '@/lib/harness/agents/outreach'
import { outreachHistory } from '@/lib/context/assemble'
import { companyFacts } from '@/lib/dossier/facts'

interface MatchDetails {
  highlights?: unknown
  skillsMatch?: { matched?: unknown }
}

export function highlightsFrom(matchDetails: unknown): string[] {
  const md = (matchDetails ?? {}) as MatchDetails
  const out: string[] = []
  if (Array.isArray(md.highlights)) {
    for (const h of md.highlights) if (typeof h === 'string') out.push(h)
  }
  if (out.length === 0 && md.skillsMatch && Array.isArray(md.skillsMatch.matched)) {
    for (const s of md.skillsMatch.matched) if (typeof s === 'string') out.push(s)
  }
  return out.slice(0, 6)
}

export interface OutreachSourceArgs {
  /** The signed-in user's client (row-level security). */
  supabase: SupabaseClient
  admin: AdminClient
  userId: string
  userEmail: string
  contactId: string | null
  jobId: string | null
  companyId: string | null
}

export interface LoadedOutreachSources {
  /** The profile's full name, or null when it is empty. A draft needs it for the sign-off. */
  senderName: string | null
  companyId: string | null
  /** The parts of OutreachDraftInput that do not depend on the contact or the kind. */
  input: Omit<OutreachDraftInput, 'userName' | 'contactName' | 'contactTitle' | 'kind'>
  hasHistory: boolean
}

export async function loadOutreachSources(args: OutreachSourceArgs): Promise<LoadedOutreachSources> {
  const { supabase, admin, userId } = args
  let companyId = args.companyId

  let jobTitle: string | null = null
  let jobDescription: string | null = null
  let matchHighlights: string[] = []
  if (args.jobId) {
    const { data: job } = await supabase
      .from('jobs')
      .select('id, title, description, company_id, match_details')
      .eq('id', args.jobId)
      .single()
    if (job) {
      jobTitle = job.title || null
      jobDescription = job.description ?? null
      companyId = job.company_id ?? companyId
      matchHighlights = highlightsFrom(job.match_details)
    }
  }

  let companyName: string | null = null
  if (companyId) {
    const { data: company } = await supabase.from('companies').select('id, name').eq('id', companyId).eq('user_id', userId).single()
    if (company) companyName = company.name
  }

  const { data: profile } = await supabase.from('profiles').select('full_name, resume_text').eq('id', userId).single()
  const senderName = profile?.full_name?.trim() || null

  const [history, facts] = await Promise.all([
    outreachHistory(admin, userId, args.contactId, companyId),
    companyFacts(admin, userId, companyId),
  ])
  const historyLines: SourceLine[] = history.lines.map((text, i) => ({ id: `H${i + 1}`, text }))

  return {
    senderName,
    companyId,
    hasHistory: historyLines.length > 0,
    input: {
      userEmail: args.userEmail,
      jobTitle,
      companyName,
      resumeText: profile?.resume_text ?? null,
      matchHighlights,
      jobDescription,
      facts,
      history: historyLines,
      patterns: history.patterns,
    },
  }
}
