import { describe, expect, it } from 'vitest'
import type { AtsJob } from '../../ats/types'
import { cleanEmployer, confirmRoles, dedupeRoles, judgeRole, mislabelledSource, onOwnSite, orderForCap, type JudgeContext } from './legit'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const DAY = 86_400_000
const ago = (d: number) => new Date(NOW - d * DAY).toISOString()

const amazon: JudgeContext = { company: { name: 'Amazon', domain: 'amazon.com', careerUrl: 'https://www.amazon.jobs/en/search' }, now: NOW }
const acme: JudgeContext = { company: { name: 'Acme', domain: 'acme.com', careerUrl: 'https://acme.com/careers' }, now: NOW }

const job = (over: Partial<AtsJob> = {}): AtsJob => ({
  title: 'Data Engineer',
  url: 'https://acme.com/jobs/1',
  externalId: 'https://acme.com/jobs/1',
  location: 'Remote',
  postedAt: ago(3),
  ...over,
})

describe('judgeRole: own', () => {
  it('labels a staffing agency and never keeps it under the employer', () => {
    expect(judgeRole(job({ employer: 'Robert Half' }), acme)).toEqual({ keep: false, why: 'agency' })
    expect(judgeRole(job({ employer: 'TEKsystems, Inc.' }), acme)).toEqual({ keep: false, why: 'agency' })
    expect(mislabelledSource(job({ employer: 'Robert Half' }), 'Acme')).toBe('This posting is from Robert Half, a staffing agency, not Acme.')
  })

  it("a name that only begins with the company's letters is another employer", () => {
    const off = (employer: string, name: string) => judgeRole(job({ employer, url: 'https://boards.greenhouse.io/x/jobs/1' }), { company: { name, domain: `${name.toLowerCase()}.com`, careerUrl: `https://${name.toLowerCase()}.com/careers` }, now: NOW })
    expect(off('Metadata Inc', 'Meta')).toEqual({ keep: false, why: 'other_employer' })
    expect(off('Uberall GmbH', 'Uber')).toEqual({ keep: false, why: 'other_employer' })
    expect(off("Applebee's International", 'Apple')).toEqual({ keep: false, why: 'other_employer' })
    expect(off('Meta Platforms', 'Meta')).toEqual({ keep: true })
  })

  it("a tracked staffing firm's own roles are kept under it", () => {
    const rh: JudgeContext = { company: { name: 'Robert Half', domain: 'roberthalf.com', careerUrl: 'https://roberthalf.com/careers' }, now: NOW }
    expect(judgeRole(job({ employer: 'Robert Half', url: 'https://roberthalf.com/jobs/1' }), rh)).toEqual({ keep: true })
    expect(mislabelledSource(job({ employer: 'Robert Half', url: 'https://roberthalf.com/jobs/1' }), 'Robert Half')).toBeNull()
  })

  it('labels a reposting site and never keeps it under the employer', () => {
    const repost = job({ url: 'https://www.linkedin.com/jobs/view/123' })
    expect(judgeRole(repost, acme)).toEqual({ keep: false, why: 'reposting' })
    expect(mislabelledSource(repost, 'Acme')).toContain('linkedin.com, a reposting site')
  })

  it('a careers link on a reposting site does not make that site the employer\'s own', () => {
    const builtin: JudgeContext = { company: { name: 'Acme', domain: 'acme.com', careerUrl: 'https://builtin.com/company/acme/jobs' }, now: NOW }
    expect(judgeRole(job({ url: 'https://builtin.com/job/1' }), builtin)).toEqual({ keep: false, why: 'reposting' })
    expect(onOwnSite('https://builtin.com/job/1', builtin)).toBe(false)
    const linkedin: JudgeContext = { company: { name: 'Acme', domain: 'acme.com', careerUrl: 'https://www.linkedin.com/jobs/search/?keywords=acme' }, now: NOW }
    expect(judgeRole(job({ url: 'https://www.linkedin.com/jobs/view/123456' }), linkedin)).toEqual({ keep: false, why: 'reposting' })
    // The employer's own site still passes, and a company whose own domain is the reposting site keeps its own pages.
    expect(judgeRole(job({ url: 'https://acme.com/jobs/1' }), builtin)).toEqual({ keep: true })
    const own: JudgeContext = { company: { name: 'Built In', domain: 'builtin.com', careerUrl: 'https://builtin.com/careers' }, now: NOW }
    expect(onOwnSite('https://builtin.com/careers/1', own)).toBe(true)
  })

  it('keeps an employer the site and the company agree on, including legal-entity names', () => {
    expect(judgeRole(job({ employer: 'Acme, Inc.' }), acme)).toEqual({ keep: true })
    const a = job({ url: 'https://www.amazon.jobs/en/jobs/1', employer: 'Amazon Data Services, Inc.' })
    expect(judgeRole(a, amazon)).toEqual({ keep: true })
    expect(judgeRole(job({ url: 'https://www.amazon.jobs/en/jobs/2', employer: 'Amazon.com Services LLC - A57' }), amazon)).toEqual({ keep: true })
  })

  it('keeps IMDb on amazon.jobs: the employer own site agrees', () => {
    expect(judgeRole(job({ url: 'https://www.amazon.jobs/en/jobs/3', employer: 'IMDb.com, Inc. - B10' }), amazon)).toEqual({ keep: true })
  })

  it('drops a role another employer posted on a board that is not the employer site', () => {
    const board = job({ url: 'https://boards.greenhouse.io/acme/jobs/9', employer: 'Totally Different Ltd' })
    expect(judgeRole(board, acme)).toEqual({ keep: false, why: 'other_employer' })
  })

  it('cleans site codes off an employer name', () => {
    expect(cleanEmployer('Amazon.com Services LLC - A57')).toBe('Amazon.com Services LLC')
    expect(cleanEmployer('Acme')).toBe('Acme')
  })
})

describe('judgeRole: open', () => {
  it('drops a role past validThrough', () => {
    expect(judgeRole(job({ validThrough: ago(1) }), acme)).toEqual({ keep: false, why: 'expired' })
    expect(judgeRole(job({ validThrough: new Date(NOW + DAY).toISOString() }), acme)).toEqual({ keep: true })
  })

  it('drops a role older than 180 days, keeps an undated one', () => {
    expect(judgeRole(job({ postedAt: ago(200) }), acme)).toEqual({ keep: false, why: 'stale' })
    expect(judgeRole(job({ postedAt: undefined }), acme)).toEqual({ keep: true })
  })
})

describe('judgeRole: real', () => {
  it('drops talent communities, general applications and events', () => {
    for (const title of ['Join our Talent Community', 'General Application', 'Open Application', 'Career Fair: Chicago', 'Info Session for new grads']) {
      expect(judgeRole(job({ title }), acme)).toEqual({ keep: false, why: 'non_role' })
    }
    expect(judgeRole(job({ isEvent: true }), acme)).toEqual({ keep: false, why: 'non_role' })
  })
})

describe('dedupeRoles', () => {
  it('keeps one role per requisition id and per title plus location', () => {
    const jobs = [
      job({ externalId: 'a', requisitionId: 'R-1' }),
      job({ externalId: 'b', title: 'Data Engineer II', requisitionId: 'r-1' }),
      job({ externalId: 'c', title: 'Backend Engineer' }),
      job({ externalId: 'd', title: 'backend  engineer' }),
    ]
    const { kept, duplicates } = dedupeRoles(jobs, [], 'sitemap')
    expect(kept.map((j) => j.externalId)).toEqual(['a', 'c'])
    expect(duplicates).toBe(2)
  })

  it('two requisitions with one title and place are two openings (Amazon lists a role once per requisition)', () => {
    const jobs = [
      job({ externalId: 'a', requisitionId: 'REQ-1', title: 'Software Dev Engineer', location: 'Seattle, WA' }),
      job({ externalId: 'b', requisitionId: 'REQ-2', title: 'Software Dev Engineer', location: 'Seattle, WA' }),
      job({ externalId: 'c', title: 'Software Dev Engineer', location: 'Seattle, WA' }),
      job({ externalId: 'd', requisitionId: 'req-1', title: 'Something Else', location: 'Austin' }),
    ]
    const { kept, duplicates } = dedupeRoles(jobs, [], 'site_search')
    expect(kept.map((j) => j.externalId)).toEqual(['a', 'b'])
    expect(duplicates).toBe(2)
  })

  it('two roles with one title and no known place are not the same role (the same title in two cities)', () => {
    const jobs = [job({ externalId: 'a', title: 'Software Engineer II', location: undefined }), job({ externalId: 'b', title: 'Software Engineer II', location: undefined })]
    expect(dedupeRoles(jobs, [], 'listing').kept).toHaveLength(2)
  })

  it('skips a role another source already stored open, but not a re-read of its own', () => {
    const stored = [{ title: 'Data Engineer', location: 'Remote', source: 'scraper', open: true, externalId: 'old' }]
    expect(dedupeRoles([job({ externalId: 'new' })], stored, 'greenhouse').kept).toHaveLength(0)
    const own = [{ title: 'Data Engineer', location: 'Remote', source: 'greenhouse', open: true, externalId: 'new' }]
    expect(dedupeRoles([job({ externalId: 'new' })], own, 'greenhouse').kept).toHaveLength(1)
    const closed = [{ title: 'Data Engineer', location: 'Remote', source: 'scraper', open: false, externalId: 'old' }]
    expect(dedupeRoles([job({ externalId: 'new' })], closed, 'greenhouse').kept).toHaveLength(1)
  })
})

describe('dedupeRoles across tiers', () => {
  it('a role with a requisition id is the same opening as a row another source stored under its title and place', () => {
    const stored = [{ title: 'Data Engineer', location: 'Remote', source: 'sitemap', open: true, externalId: 'https://acme.com/jobs/9' }]
    expect(dedupeRoles([job({ externalId: 'gh-1', requisitionId: 'R-7' })], stored, 'greenhouse')).toMatchObject({ duplicates: 1 })
    // Its own source's row is an update, and a closed row is not an opening.
    expect(dedupeRoles([job({ externalId: 'gh-1', requisitionId: 'R-7' })], [{ ...stored[0], source: 'greenhouse', externalId: 'gh-1' }], 'greenhouse').kept).toHaveLength(1)
    expect(dedupeRoles([job({ externalId: 'gh-1', requisitionId: 'R-7' })], [{ ...stored[0], open: false }], 'greenhouse').kept).toHaveLength(1)
  })
})

describe('confirmRoles: a page that is only its site shell is not a role', () => {
  const shell = (n: number): AtsJob => ({ title: 'Acme Careers Home', url: `https://acme.com/jobs/${n}`, externalId: `https://acme.com/jobs/${n}` })

  it('the same few words on three pages with no place, date or id are dropped', () => {
    expect(confirmRoles([shell(1), shell(2), shell(3)], 'Acme Corp')).toEqual([])
  })

  it('twice is not enough to call it a shell, and a place, date or id on each rescues it', () => {
    expect(confirmRoles([shell(1), shell(2)], 'Acme Corp')).toHaveLength(2)
    expect(confirmRoles([shell(1), shell(2), shell(3)].map((j) => ({ ...j, location: 'Berlin' })), 'Acme Corp')).toHaveLength(3)
  })

  it('a title that is only the company name is dropped', () => {
    expect(confirmRoles([{ ...shell(1), title: 'Acme Careers' }], 'Acme')).toEqual([])
  })
})

describe('orderForCap', () => {
  it('puts roles inside the targets first, then unread, then outside; newest first within each', () => {
    const jobs = [
      job({ externalId: 'out-new', postedAt: ago(1) }),
      job({ externalId: 'in-old', postedAt: ago(30) }),
      job({ externalId: 'in-new', postedAt: ago(2) }),
      job({ externalId: 'unread', postedAt: ago(1) }),
    ]
    const verdict: Record<string, 'inside' | 'outside' | 'unclassified'> = { 'out-new': 'outside', 'in-old': 'inside', 'in-new': 'inside', unread: 'unclassified' }
    expect(orderForCap(jobs, (j) => verdict[j.externalId]).map((j) => j.externalId)).toEqual(['in-new', 'in-old', 'unread', 'out-new'])
  })
})
