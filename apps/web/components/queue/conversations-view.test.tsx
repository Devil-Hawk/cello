// Conversations: six groups in one order, Approve and send all only when every check passed, the Person sheet's
// three actions, role titles at the company's weight, handled clears a row, and the states.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationsView, GROUP_TITLES, approveAllIds, sendDrafts, type ConversationsViewProps } from './conversations-view'
import { ReplyRow } from './reply-row'
import { PersonSheet, SheetActions, markContacted } from './person-sheet'
import type { OutreachRow } from './outreach-card'
import type { ReplyRow as Reply } from '@/lib/network/conversations'
import type { DueNudge } from '@/lib/network/nudges'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))

const reply = (i: number, over: Partial<Reply> = {}): Reply => ({
  id: `m${i}`,
  threadId: `t${i}`,
  from: `Marcus ${i}`,
  contactId: `c${i}`,
  subject: `About the role ${i}`,
  excerpt: 'Thanks for applying.\nCan you talk Tuesday?',
  sentAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  kind: 'interview',
  applicationId: `a${i}`,
  role: { id: `r${i}`, title: 'Staff Machine Learning Engineer, Applied Research and Platform', company: 'Petrichor Labs' },
  contact: { name: `Marcus ${i}`, title: 'Recruiter', employer: 'Petrichor Labs', email: `marcus${i}@petrichor.ai` },
  ...over,
})

const draft = (i: number, pass = true): OutreachRow => ({ id: `d${i}`, to_email: `d${i}@x.com`, to_name: `D ${i}`, subject: 's', body: 'b', status: 'pending_review', kind: 'initial', created_at: '2026-03-01T00:00:00Z', verdicts: [{ judge: 'groundedness', verdict: pass ? 'pass' : 'fail', score: 1, rationale: null }] })

const due: DueNudge = { contactId: 'c9', name: 'Dana Lee', firstName: 'Dana', email: 'dana@x.com', title: 'Recruiter', employer: 'Ramp', agency: null, waitingOn: 'them', fact: 'You wrote last, 6 business days ago.', dueAt: '2026-03-01T00:00:00Z', threadId: 't', tie: { applicationId: 'a9', roleId: 'r9', roleTitle: 'Data Engineer', company: 'Ramp', stage: 'applied' }, draftId: null }

const base: ConversationsViewProps = {
  data: { replies: [], recruiters: [], writeTo: [], gmailConnected: true },
  outreach: [],
  due: [],
  gmailConnected: true,
  limit: { cap: 10, sentToday: 0 },
  onHandled: () => undefined,
  onChanged: () => undefined,
}
const html = (over: Partial<ConversationsViewProps>) => renderToStaticMarkup(<ConversationsView {...base} {...over} />).replace(/<!-- -->/g, '')

describe('the order', () => {
  it('reads replies, drafts, follow-ups, recruiters, people to write to, then sent', () => {
    expect(GROUP_TITLES).toEqual(['Replies waiting on you', 'Drafts to approve', 'Follow-ups due', 'New from recruiters', 'People to write to', 'Sent'])
    const out = html({
      data: { replies: [reply(1)], recruiters: [reply(2, { kind: 'recruiter', applicationId: null, role: null })], writeTo: [{ id: 'w1', name: 'Quinn', title: null, employer: 'Ramp', why: 'In your network, and you have not written to them yet.' }], gmailConnected: true },
      due: [due],
    })
    const at = (s: string) => out.indexOf(s)
    expect(at('Replies waiting on you')).toBeLessThan(at('Follow-ups due'))
    expect(at('Follow-ups due')).toBeLessThan(at('New from recruiters'))
    expect(at('New from recruiters')).toBeLessThan(at('People to write to'))
  })
})

describe('Approve and send all', () => {
  it('shows only when there are several drafts and every check passed', () => {
    expect(approveAllIds([draft(1), draft(2), draft(3), draft(4), draft(5)])).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(approveAllIds([draft(1)])).toEqual([])
    expect(approveAllIds([draft(1), draft(2, false)])).toEqual([])
    expect(approveAllIds([draft(1), { ...draft(2), verdicts: [] }])).toEqual([])
  })
})

describe('a reply', () => {
  it('shows the role title in the same class as the company, and opens the record', () => {
    const out = html({ data: { ...base.data, replies: [reply(1)] } })
    expect(out).toContain('Staff Machine Learning Engineer, Applied Research and Platform')
    expect(out).toContain('href="/roles/r1"')
    expect((out.match(/class="r-name/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(out).not.toMatch(/truncate|line-clamp/)
  })
  it('offers Read all, Write my own reply, Draft reply, Open in Gmail and I have handled this, and nothing that sends', () => {
    const out = renderToStaticMarkup(<ReplyRow r={reply(1)} onHandled={() => undefined} onPerson={() => undefined} />)
    for (const label of ['Read all', 'Write my own reply', 'Draft reply', 'Open in Gmail', 'I have handled this']) expect(out).toContain(label)
    expect(out).not.toMatch(/Approve|Send now|Send</)
  })
  it('offers no Draft reply without an address, and no Gmail links on a pasted email', () => {
    expect(renderToStaticMarkup(<ReplyRow r={reply(1, { contact: { name: 'M', title: null, employer: null, email: null } })} onHandled={() => undefined} onPerson={() => undefined} />)).not.toContain('Draft reply')
    const pasted = renderToStaticMarkup(<ReplyRow r={reply(1, { threadId: 'paste:abc' })} onHandled={() => undefined} onPerson={() => undefined} />)
    expect(pasted).not.toMatch(/Open in Gmail|Read all|Write my own reply/)
    expect(pasted).toContain('I have handled this')
  })
  it('shows the first lines and Cello’s read of the kind', () => {
    const out = renderToStaticMarkup(<ReplyRow r={reply(1)} onHandled={() => undefined} onPerson={() => undefined} />).replace(/<!-- -->/g, '')
    expect(out).toContain('Thanks for applying.')
    expect(out).toContain('An interview')
  })
})

describe('states', () => {
  it('asks to connect Gmail when it is not connected', () => {
    const out = html({ gmailConnected: false })
    expect(out).toContain('Connect Gmail to see replies here.')
    expect(out).toContain('It never sends without your click.')
  })
  it('says nobody is waiting when nothing is', () => expect(html({})).toContain('Nobody is waiting on you.'))
  it('says the daily limit was reached', () => expect(html({ limit: { cap: 10, sentToday: 10 } })).toContain('10 sent today, your daily limit. The rest go tomorrow.'))
})

describe('the Person sheet', () => {
  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<PersonSheet person={null} onClose={() => undefined} />)).toBe('')
  })
  const person = { id: 'c1', name: 'Marcus Reed', title: 'Recruiter', employer: 'Petrichor Labs', email: 'marcus@petrichor.ai' }
  it('offers Email, Mark contacted today and Open, which goes to the person’s page', () => {
    const out = renderToStaticMarkup(<SheetActions person={person} note={null} onMark={() => undefined} />)
    expect(out).toContain('href="mailto:marcus@petrichor.ai"')
    expect(out).toContain('Mark contacted today')
    expect(out).toMatch(/href="\/network\/c1"[^>]*>Open</)
  })
  it('shows no Email when the address is not known', () => {
    expect(renderToStaticMarkup(<SheetActions person={{ ...person, email: null }} note={null} onMark={() => undefined} />)).not.toContain('Email')
  })
  it('marks the person contacted through people.mark_contacted and says what happened', async () => {
    const call = vi.fn(async () => ({}))
    expect(await markContacted('c1', call as never)).toBe('Marked as contacted today.')
    expect(call).toHaveBeenCalledWith('/api/network', 'people.mark_contacted', { id: 'c1' })
    expect(await markContacted('c1', (async () => { throw new Error('That person is not in your network.') }) as never)).toBe('That person is not in your network.')
  })
  it('opens from a reply with the contact’s email', () => {
    const out = renderToStaticMarkup(<SheetActions person={{ ...person, email: reply(3).contact?.email }} note={null} onMark={() => undefined} />)
    expect(out).toContain('mailto:marcus3@petrichor.ai')
  })
})

describe('Approve and send all sends once per draft', () => {
  it('posts each draft once, in order, and stops at the first refusal', async () => {
    const post = vi.fn(async (id: string) => ({ ok: id !== 'd3' }))
    expect(await sendDrafts(['d1', 'd2', 'd3', 'd4'], post)).toBe(2)
    expect(post.mock.calls.map((c) => c[0])).toEqual(['d1', 'd2', 'd3'])
    const all = vi.fn(async () => ({ ok: true }))
    expect(await sendDrafts(['d1', 'd2', 'd3'], all)).toBe(3)
    expect(all).toHaveBeenCalledTimes(3)
  })
})

describe('the menu and the draft link', () => {
  it('has a menu key, and offers Paste an email beside Connect Gmail when Gmail is off', () => {
    expect(html({})).toContain('aria-label="Conversations menu"')
    const off = html({ gmailConnected: false })
    expect(off).toContain('Connect Gmail to see replies here, or paste an email.')
    expect(off).toContain('Paste an email')
  })
  it('marks the draft a link asked for', () => {
    const out = html({ outreach: [draft(1), draft(2)], focusDraft: 'd2' })
    expect(out).toMatch(/id="draft-d2" class="[^"]*ring-2/)
    expect(out).not.toMatch(/id="draft-d1" class="[^"]*ring-2/)
  })
})
