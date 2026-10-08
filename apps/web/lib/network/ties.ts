// Which employer a person works for, by code and in this order: a verified company_directory domain, the
// application their thread is about, the agency list. A relay never names an employer (the filter has
// already left relays out), and neither does a personal address: recruiters write from gmail.com, so
// their employer comes from the thread's application or from the person.

export interface TieInput {
  addressKind: 'employer' | 'personal'
  /** The directory employer whose verified domain is the address's own, else null. */
  domainEmployerId: string | null
  /** The employer the thread's application is at, else null. */
  threadEmployerId: string | null
  agencyName: string | null
}

export type Tie =
  | { employerId: string; agencyName: null; prov: { rule: string } }
  | { employerId: null; agencyName: string; prov: { rule: string } }
  | null

export function employerTie(i: TieInput): Tie {
  if (i.addressKind === 'employer' && i.domainEmployerId) {
    return { employerId: i.domainEmployerId, agencyName: null, prov: { rule: 'their address is at the employer\'s verified domain' } }
  }
  if (i.threadEmployerId) return { employerId: i.threadEmployerId, agencyName: null, prov: { rule: 'the thread is about an application at this employer' } }
  if (i.agencyName) return { employerId: null, agencyName: i.agencyName, prov: { rule: 'recruiter at an agency' } }
  return null
}
