// What kind of person wrote to you, by the words in their name, address and mail. Code only; the model
// step (inbox.employer) may refine the employer later, and a person's own edit always wins.
//
//   recruiter           a recruiter or talent partner at the employer itself
//   agency_recruiter    a recruiter at a staffing or search firm (the agency, not the employer)
//   hiring_manager      says they lead the team the role is on
//   referrer            offers to refer you
//   other               everything else

import type { SupabaseClient } from '@supabase/supabase-js'

export type ContactKind = 'recruiter' | 'agency_recruiter' | 'hiring_manager' | 'referrer' | 'other'

export interface KindInput {
  displayName: string | null
  address: string | null
  subject: string
  body: string
}

const AGENCY = /\b(staffing|talent partners?|search (firm|partners?)|executive search|recruitment (agency|consultan\w+)|recruiting (agency|group)|\w+ (resourcing|solutions) (group|ltd|inc)|robert half|randstad|adecco|hays|kforce|insight global|tek ?systems|manpower)\b/i
const RECRUITER = /\b(recruiter|talent (acquisition|partner)|sourcer|recruiting|technical recruiter|hiring partner)\b/i
const MANAGER = /\b(i('| a)m (the )?(hiring manager|leading|an? (engineering|data|product) (manager|lead|director))|i lead (the|our) |hiring manager for)\b/i
const REFERRER = /\b(i can (refer|put in a referral)|happy to refer|i('d| would) (be happy to )?refer you|referral for you)\b/i

/** The agency's name when the sender's display name or signature gives one, else null. */
function agencyName(displayName: string | null, body: string): string | null {
  const text = `${displayName ?? ''}\n${body.slice(0, 600)}`
  const m = /\b([A-Z][\w&]+(?: [A-Z][\w&]+){0,2}) (Staffing|Talent Partners|Search Partners|Recruitment|Resourcing)\b/.exec(text)
  return m ? `${m[1]} ${m[2]}` : null
}

export function contactKind(i: KindInput): { kind: ContactKind; agencyName: string | null } {
  const identity = `${i.displayName ?? ''} ${i.address ?? ''} ${i.body.slice(0, 600)}`
  const body = `${i.subject}\n${i.body.slice(0, 1500)}`
  if (AGENCY.test(identity)) return { kind: 'agency_recruiter', agencyName: agencyName(i.displayName, i.body) }
  if (REFERRER.test(body)) return { kind: 'referrer', agencyName: null }
  if (MANAGER.test(body)) return { kind: 'hiring_manager', agencyName: null }
  if (RECRUITER.test(identity) || RECRUITER.test(i.subject)) return { kind: 'recruiter', agencyName: null }
  return { kind: 'other', agencyName: null }
}

/**
 * The person's contact for this address: found by email, or made. A kind that was already set is
 * kept (the person may have changed it). Returns the contact id, or null when the address is not usable.
 */
export async function linkContact(
  admin: SupabaseClient,
  userId: string,
  c: { name: string | null; address: string | null; kind: ContactKind; agencyName: string | null; companyId: string | null; employerId: string | null },
): Promise<string | null> {
  const email = c.address?.trim().toLowerCase() ?? null
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  const { data: have } = await admin.from('contacts').select('id, kind').eq('user_id', userId).ilike('email', email).limit(1).maybeSingle()
  const row = have as { id: string; kind: string | null } | null
  if (row) {
    if (!row.kind) await admin.from('contacts').update({ kind: c.kind, agency_name: c.agencyName }).eq('id', row.id).eq('user_id', userId)
    return row.id
  }
  const ins = await admin
    .from('contacts')
    .insert({
      user_id: userId,
      name: (c.name ?? email.split('@')[0]).slice(0, 200),
      email,
      company_id: c.companyId,
      kind: c.kind,
      agency_name: c.agencyName,
      employer_id: c.employerId,
      employer_origin: c.employerId ? 'code' : null,
      employer_prov: c.employerId ? { rule: 'sender domain is the verified employer' } : null,
      relationship: 'recruiter mail',
    })
    .select('id')
    .single()
  return (ins.data as { id: string } | null)?.id ?? null
}
