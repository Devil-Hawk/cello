// The demo's network: header rows of mail with the demo contacts, two excerpts, one tie and one follow-up
// that is due. Addresses are the example.com ones of contacts.ts, so nothing here can reach a person.
// The demo gets no memories: the memory store refuses demo writes.

export interface DemoMessage {
  key: string
  contactSlug: string
  /** The thread's application, by job slug, or null. */
  applicationJobSlug: string | null
  threadKey: string
  direction: 'in' | 'out'
  daysAgo: number
  subject: string
  /** The first lines, only on the two rows the demo shows as excerpts. */
  excerpt: string | null
}

export const DEMO_MESSAGES: readonly DemoMessage[] = [
  // Elena wrote back once and the last message is yours, 11 days ago: a follow-up is due.
  { key: 'elena-1', contactSlug: 'elena-vasquez', applicationJobSlug: null, threadKey: 'elena', direction: 'out', daysAgo: 14, subject: 'A question about the platform team', excerpt: null },
  {
    key: 'elena-2',
    contactSlug: 'elena-vasquez',
    applicationJobSlug: null,
    threadKey: 'elena',
    direction: 'in',
    daysAgo: 12,
    subject: 'Re: A question about the platform team',
    excerpt: 'Thanks for writing. The team is hiring two engineers this quarter.\nSend me your resume and I will pass it on.',
  },
  { key: 'elena-3', contactSlug: 'elena-vasquez', applicationJobSlug: null, threadKey: 'elena', direction: 'out', daysAgo: 11, subject: 'Re: A question about the platform team', excerpt: null },
  // Aisha wrote 6 days ago about the application and has not been answered.
  {
    key: 'aisha-1',
    contactSlug: 'aisha-rahman',
    applicationJobSlug: 'quillon-cloud-security',
    threadKey: 'aisha',
    direction: 'in',
    daysAgo: 6,
    subject: 'Interview loop for the security role',
    excerpt: 'We would like to set up a loop of four conversations.\nWhich days next week work for you?',
  },
]

/** One person tied to the application their mail is about. */
export const DEMO_TIES: readonly { contactSlug: string; applicationJobSlug: string }[] = [{ contactSlug: 'aisha-rahman', applicationJobSlug: 'quillon-cloud-security' }]
