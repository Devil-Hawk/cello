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
import { fitHighlights, fitRowOf } from '@/lib/scoring/read'

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
      .select('id, title, description, company_id, person_roles(chance_detail)')
      .eq('id', args.jobId)
      // A no-op under row-level security; under the service client (the Writer) it keeps another follower's verdict out of this draft.
      .eq('person_roles.user_id', userId)
      .single()
    if (job) {
      jobTitle = job.title || null
      jobDescription = job.description ?? null
      companyId = job.company_id ?? companyId
      // Only what the resume really shows, each with the line that shows it: nothing the model could invent.
      matchHighlights = fitHighlights(fitRowOf(job).chance_detail)
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
