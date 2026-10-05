import { describe, expect, it } from 'vitest'
import { buildDigest, jobReason, type DigestState } from './build'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const empty: DigestState = {
  companyCount: 0,
  pendingOutreach: 0,
  pendingApplications: 0,
  replies: [],
  followUps: [],
  roles: [],
  applications: [],
  sentLast30: 0,
  repliesLast30: 0,
}

const role = (over: Partial<DigestState['roles'][number]> = {}): DigestState['roles'][number] => ({
  id: 'j1',
  title: 'Staff Engineer',
  company: 'Linear',
  url: 'https://linear.app/jobs/1',
  score: 88,
  summary: 'Your Go and Postgres work maps directly to the payments ledger this role owns.',
  discoveredAt: daysAgo(1),
  stillOpen: true,
  hasApplication: false,
  ...over,
})

const rich: DigestState = {
  companyCount: 42,
  pendingOutreach: 3,
  pendingApplications: 1,
  replies: [{ name: 'Jane Park', company: 'Ramp', jobTitle: 'Senior Backend Engineer', repliedAt: daysAgo(2) }],
  followUps: [{ name: 'Sam Lee', company: 'Notion', sentAt: daysAgo(9) }],
  roles: [role()],
  applications: [
    { id: 'a1', stage: 'interview', title: 'Data Scientist', company: 'Acme', appliedAt: daysAgo(20), updatedAt: daysAgo(2), kit: { id: 'k1', questions: 12, stories: 3 } },
    { id: 'a2', stage: 'screen', title: 'Product Designer', company: 'Figma', appliedAt: daysAgo(30), updatedAt: daysAgo(3), kit: null },
    { id: 'a3', stage: 'applied', title: 'Product Designer', company: 'Figma', appliedAt: daysAgo(16), updatedAt: daysAgo(16), kit: null },
  ],
  sentLast30: 14,
  repliesLast30: 3,
}

const allText = (state: DigestState) => {
  const d = buildDigest(state, NOW)
  return [d.subject, d.text, d.html, ...d.sections.flatMap((s) => [s.title, ...s.items.map((i) => i.text)])].join('\n')
}

describe('new roles', () => {
  const ids = (state: DigestState) => buildDigest(state, NOW).sections.find((s) => s.id === 'new_roles')?.items.map((i) => i.text) ?? []

  it('leaves out a role the user has applied to, a closed role, and one older than a week', () => {
    const out = ids({
      ...empty,
      companyCount: 1,
      roles: [
        role({ id: 'a', title: 'Applied Role', hasApplication: true }),
        role({ id: 'b', title: 'Closed Role', stillOpen: false }),
        role({ id: 'c', title: 'Old Role', discoveredAt: daysAgo(9) }),
        role({ id: 'd', title: 'Open Role' }),
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('Open Role')
  })

  it('keeps a role whose open state is unknown, shows at most five, best score first', () => {
    const roles = Array.from({ length: 8 }, (_, i) => role({ id: `r${i}`, title: `Role ${i}`, score: i * 10, stillOpen: null }))
    const out = ids({ ...empty, roles })
    expect(out).toHaveLength(5)
    expect(out[0]).toContain('Role 7')
  })

  it('gives every role a reason and a link', () => {
    const items = buildDigest({ ...empty, roles: [role(), role({ id: 'x', summary: null, url: null, score: 71 })] }, NOW).sections[0].items
    expect(items[0].text).toBe('Staff Engineer at Linear: Your Go and Postgres work maps directly to the payments ledger this role owns.')
    expect(items[0].href).toBe('https://linear.app/jobs/1')
    expect(items[1].text).toContain('Scored 71 for you.')
    expect(items[1].href).toBe('/jobs')
  })
})

describe('jobReason', () => {
  it('uses the first sentence, up to 140 characters, cut at a word', () => {
    expect(jobReason('Strong fit. Second sentence.', 80)).toBe('Strong fit.')
    const long = `${'word '.repeat(60)}end.`
    const r = jobReason(long, 80)
    expect(r.length).toBeLessThanOrEqual(141)
    expect(r.endsWith('word.')).toBe(true)
  })

  it('says what is known and no more when there is no summary', () => {
    expect(jobReason(null, 90)).toBe('Scored 90 for you.')
    expect(jobReason('  ', null)).toBe('Found in the last 7 days.')
  })
})

describe('every item names what to do and where', () => {
  const d = buildDigest(rich, NOW)

  it('has the sections in order, with a link on every item except what is working', () => {
    expect(d.sections.map((s) => s.id)).toEqual(['replies', 'approvals', 'follow_ups', 'new_roles', 'interview_prep', 'gone_quiet', 'working'])
    for (const s of d.sections.filter((x) => x.id !== 'working')) for (const i of s.items) expect(i.href, i.text).toBeTruthy()
  })

  it('writes the lines the way a person would say them, with exact numbers', () => {
    const text = d.sections.flatMap((s) => s.items.map((i) => i.text))
    expect(text).toContain('Jane Park at Ramp replied 2 days ago about Senior Backend Engineer.')
    expect(text).toContain('3 outreach drafts and 1 application are waiting for your approval.')
    expect(text).toContain('No reply from Sam Lee at Notion in 9 days. One follow-up is allowed.')
    expect(text).toContain('Interview at Acme for Data Scientist: prep kit ready, 12 questions and 3 stories.')
    expect(text).toContain('Screen at Figma for Product Designer: no prep kit yet.')
    expect(text).toContain('Applied to Figma 16 days ago for Product Designer, no update since.')
  })

  it('says 3 replies from 14 emails exactly', () => {
    expect(d.sections.find((s) => s.id === 'working')?.items[0].text).toBe('You sent 14 emails and got 3 replies in the last 30 days.')
  })

  it('links a prep kit that exists, and the prep page when there is none', () => {
    const prep = d.sections.find((s) => s.id === 'interview_prep')!.items
    expect(prep[0].href).toBe('/prep/k1')
    expect(prep[1].href).toBe('/prep')
  })

  it('does not call a recent application quiet', () => {
    expect(d.sections.find((s) => s.id === 'gone_quiet')?.items).toHaveLength(1)
  })
})

describe('what is working', () => {
  it('says there is too little to tell when fewer than five emails went out', () => {
    const w = buildDigest({ ...empty, sentLast30: 3, repliesLast30: 1 }, NOW).sections.find((s) => s.id === 'working')!
    expect(w.items[0].text).toBe('You sent 3 emails in the last 30 days. Too few to tell what is working yet.')
    expect(buildDigest({ ...empty, sentLast30: 0 }, NOW).sections[0].items[0].text).toBe('You sent no emails in the last 30 days. Too few to tell what is working yet.')
  })

  it('handles the singular', () => {
    expect(buildDigest({ ...empty, sentLast30: 5, repliesLast30: 1 }, NOW).sections[0].items[0].text).toBe('You sent 5 emails and got 1 reply in the last 30 days.')
  })
})

describe('the empty digest', () => {
  it('says what Cello is watching, and has no long dash or filler', () => {
    const d = buildDigest({ ...empty, companyCount: 42 }, NOW)
    expect(d.empty).toBe(true)
    expect(d.subject).toBe('Cello daily: nothing needs you today')
    expect(d.text).toContain('Nothing needs you today. Cello is watching 42 companies and will write when something changes.')
    expect(d.html).toContain('Nothing needs you today. Cello is watching 42 companies')
    expect(allText({ ...empty, companyCount: 42 })).not.toMatch(/[–—]/)
    expect(d.text).not.toMatch(/enjoy the calm|great job/i)
  })

  it('says what to do next when there are no companies', () => {
    expect(buildDigest(empty, NOW).text).toContain('Nothing needs you today. Add companies to watch and Cello will look for roles there.')
  })

  it('is not empty because of the what-is-working line alone, and not made non-empty by it', () => {
    expect(buildDigest({ ...empty, sentLast30: 20, repliesLast30: 4 }, NOW).empty).toBe(true)
  })
})

describe('subject and formatting', () => {
  it('lists the non-zero parts, three at most', () => {
    expect(buildDigest(rich, NOW).subject).toBe('Cello daily: 1 reply, 4 drafts to approve, 1 new role')
    expect(buildDigest({ ...empty, replies: rich.replies, pendingOutreach: 2 }, NOW).subject).toBe('Cello daily: 1 reply, 2 drafts to approve')
  })

  it('has no long dash anywhere in a full digest and escapes the html', () => {
    expect(allText(rich)).not.toMatch(/[–—]/)
    const html = buildDigest({ ...empty, roles: [role({ title: 'Engineer <script>', company: 'A & B' })] }, NOW).html
    expect(html).toContain('Engineer &lt;script&gt; at A &amp; B')
    expect(html).not.toContain('<script>')
  })

  it('writes absolute links in the email and keeps the paths in the data', () => {
    const d = buildDigest(rich, NOW, 'https://app.example.test')
    expect(d.html).toContain('href="https://app.example.test/queue?tab=outreach"')
    expect(d.sections[0].items[0].href).toBe('/queue?tab=outreach')
  })

  it('does not list a reply older than two weeks', () => {
    const d = buildDigest({ ...empty, replies: [{ name: 'Old', company: null, jobTitle: null, repliedAt: daysAgo(20) }] }, NOW)
    expect(d.sections.find((s) => s.id === 'replies')).toBeUndefined()
  })
})
