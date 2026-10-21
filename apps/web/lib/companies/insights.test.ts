import { afterEach, describe, expect, it, vi } from 'vitest'
import { ashby } from '../ats/ashby'
import { lever } from '../ats/lever'
import type { AtsJob } from '../ats/types'
import { computeInsights, MIN_CLOSES } from './insights'
import { stackWords } from './stack-words'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()
const job = (id: string, title: string, o: Partial<AtsJob> = {}): AtsJob => ({ title, url: `https://x.test/${id}`, externalId: id, ...o })
const closes = (days: number[]) => days.map((d) => ({ firstSeen: ago(d + 1), closedAt: ago(1) }))

describe('computeInsights', () => {
  it('knows nothing from an empty board: counts are zero, everything else is null or empty', () => {
    const i = computeInsights([], { now: NOW, closes: [] })
    expect(i).toEqual({
      open: 0, byType: [], bySeniority: {}, locations: [], remoteShare: null, posted7d: 0, posted30d: 0,
      pay: { stated: 0, min: null, max: null, currency: null }, medianAgeDays: null, typicalCloseDays: null, closesSeen: 0, stack: [],
    })
  })

  it('counts a board by type, seniority and place, and the share that is remote', () => {
    const i = computeInsights(
      [
        job('1', 'Senior Software Engineer', { location: 'New York, NY' }),
        job('2', 'Software Engineer', { location: ' new york, ny ' }),
        job('3', 'Account Executive', { location: 'Paris · Berlin' }),
        job('4', 'Junior Software Engineer', { location: 'Remote - US' }),
        job('5', 'Support Engineer', { location: 'Tokyo, Japan; Paris' }),
      ],
      { now: NOW, closes: [] }
    )
    expect(i.open).toBe(5)
    expect(i.byType.reduce((n, t) => n + t.open, 0)).toBe(5)
    expect(i.byType[0].open).toBeGreaterThanOrEqual(i.byType[i.byType.length - 1].open)
    expect(i.bySeniority).toMatchObject({ senior: 1, junior: 1 })
    // places are folded by case and spacing, counted once a posting, and a posting's several places (Ashby's " · ", Greenhouse's ";") are split
    expect(i.locations).toEqual([
      { name: 'New York, NY', count: 2 },
      { name: 'Paris', count: 2 },
      { name: 'Berlin', count: 1 },
      { name: 'Remote - US', count: 1 },
      { name: 'Tokyo, Japan', count: 1 },
    ])
    expect(i.remoteShare).toBe(0.2)
  })

  it('keeps the eight most common places', () => {
    const jobs = Array.from({ length: 12 }, (_, n) => job(String(n), 'Engineer', { location: `City ${String(n).padStart(2, '0')}` }))
    expect(computeInsights(jobs, { now: NOW, closes: [] }).locations).toHaveLength(8)
  })

  it('counts postings of the last 7 and 30 days and takes the median age, leaving out postings with no date', () => {
    const i = computeInsights([job('1', 'A', { postedAt: ago(2) }), job('2', 'B', { postedAt: ago(10) }), job('3', 'C', { postedAt: ago(40) }), job('4', 'D')], { now: NOW, closes: [] })
    expect(i).toMatchObject({ open: 4, posted7d: 1, posted30d: 2, medianAgeDays: 10 })
    expect(computeInsights([job('1', 'A')], { now: NOW, closes: [] }).medianAgeDays).toBeNull()
  })

  it('reports one yearly range in one currency and counts only the postings inside it', () => {
    const i = computeInsights(
      [
        job('1', 'A', { salary: 'USD 140,000–240,000 / yr' }),
        job('2', 'B', { salary: 'USD 120,000–200,000 per year' }),
        job('3', 'C', { salary: 'EUR 90,000 per year' }),
        job('4', 'D', { salary: 'USD 60 per hour' }),
        job('5', 'E', { salary: 'Competitive' }),
        job('6', 'F'),
      ],
      { now: NOW, closes: [] }
    )
    expect(i.pay).toEqual({ stated: 2, min: 120000, max: 240000, currency: 'USD' })
  })

  it('has no pay when no posting gives a yearly range', () => {
    const none = { stated: 0, min: null, max: null, currency: null }
    expect(computeInsights([job('1', 'A', { salary: 'Competitive' }), job('2', 'B', { salary: 'USD 60 per hour' })], { now: NOW, closes: [] }).pay).toEqual(none)
    expect(computeInsights([job('1', 'A')], { now: NOW, closes: [] }).pay).toEqual(none)
  })

  it('breaks a tie between currencies by count, then USD first, then the code', () => {
    const gbp = (id: string) => job(id, 'A', { salary: 'GBP 40,000–45,000 / yr' })
    const usd = (id: string) => job(id, 'B', { salary: 'USD 100,000–120,000 / yr' })
    const pay = (jobs: AtsJob[]) => computeInsights(jobs, { now: NOW, closes: [] }).pay
    expect(pay([gbp('1'), usd('2')])).toEqual({ stated: 1, min: 100000, max: 120000, currency: 'USD' })
    expect(pay([gbp('1'), gbp('2'), usd('3')])).toEqual({ stated: 2, min: 40000, max: 45000, currency: 'GBP' })
    expect(pay([job('1', 'A', { salary: 'GBP 40,000 / yr' }), job('2', 'B', { salary: 'CAD 70,000 / yr' })]).currency).toBe('CAD')
  })

  describe('pay as the adapters really write it', () => {
    const realFetch = globalThis.fetch
    afterEach(() => {
      globalThis.fetch = realFetch
      vi.restoreAllMocks()
    })
    const respond = (body: unknown) => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    }

    it('reads a Lever posting: per-year-salary is a yearly range, per-hour-wage is not', async () => {
      const posting = (id: string, salaryRange: unknown) => ({ id, text: `Engineer ${id}`, hostedUrl: `https://jobs.lever.co/acme/${id}`, categories: {}, salaryRange })
      respond([
        posting('a', { min: 150000, max: 190000, currency: 'usd', interval: 'per-year-salary' }),
        posting('b', { min: 120000, max: 160000, currency: 'usd', interval: 'per-year-salary' }),
        posting('c', { min: 60, max: 80, currency: 'usd', interval: 'per-hour-wage' }),
      ])
      const jobs = await lever.fetch('acme')
      expect(jobs.map((j) => j.salary)).toEqual(['USD 150,000–190,000 per year salary', 'USD 120,000–160,000 per year salary', 'USD 60–80 per hour wage'])
      expect(computeInsights(jobs, { now: NOW, closes: [] }).pay).toEqual({ stated: 2, min: 120000, max: 190000, currency: 'USD' })
    })

    it('reads an Ashby posting and names a currency that is not USD', async () => {
      const posting = (id: string, currencyCode: string, minValue: number, maxValue: number) => ({
        title: `Engineer ${id}`, jobUrl: `https://jobs.ashbyhq.com/acme/${id}`, isListed: true,
        compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode, minValue, maxValue }] },
      })
      respond({ jobs: [posting('a', 'GBP', 60000, 90000), posting('b', 'GBP', 80000, 120000), posting('c', 'USD', 100000, 150000)] })
      const jobs = await ashby.fetch('acme')
      expect(computeInsights(jobs, { now: NOW, closes: [] }).pay).toEqual({ stated: 2, min: 60000, max: 120000, currency: 'GBP' })
    })
  })

  it('gives a typical close time only from ten closings, as the median of the days between first seen and closed', () => {
    const few = computeInsights([], { now: NOW, closes: closes([5, 6, 7, 8, 9, 10, 11, 12, 13]) })
    expect(few).toMatchObject({ typicalCloseDays: null, closesSeen: MIN_CLOSES - 1 })
    const ten = computeInsights([], { now: NOW, closes: closes([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) })
    expect(ten).toMatchObject({ typicalCloseDays: 10, closesSeen: 10 }) // median of 5..14 is 9.5, rounded
    // a close that precedes its first sighting is not a measurement
    expect(computeInsights([], { now: NOW, closes: [{ firstSeen: ago(1), closedAt: ago(5) }] }).closesSeen).toBe(0)
  })

  it('counts the technology words once a posting, from the title and the text', () => {
    const i = computeInsights(
      [
        job('1', 'Python Engineer', { description: 'Python, Python and Kubernetes. We use Go.' }),
        job('2', 'Engineer', { description: 'Kubernetes on AWS with PostgreSQL and C++' }),
        job('3', 'Engineer', { description: 'Ready to go? Work with a team that cares about rust and spark.' }),
      ],
      { now: NOW, closes: [] }
    )
    expect(i.stack).toEqual([
      { name: 'Kubernetes', count: 2 },
      { name: 'AWS', count: 1 },
      { name: 'C++', count: 1 },
      { name: 'Go', count: 1 },
      { name: 'PostgreSQL', count: 1 },
      { name: 'Python', count: 1 },
    ])
  })

  it('leaves the employer itself out of the stack: a Datadog posting names Datadog every time', () => {
    const jobs = [job('1', 'Engineer', { description: 'Join Datadog. We run Kubernetes.' })]
    expect(computeInsights(jobs, { now: NOW, closes: [], employer: 'Datadog, Inc.' }).stack).toEqual([{ name: 'Kubernetes', count: 1 }])
    expect(computeInsights(jobs, { now: NOW, closes: [] }).stack).toEqual([{ name: 'Datadog', count: 1 }, { name: 'Kubernetes', count: 1 }])
  })
})

describe('stackWords', () => {
  it('matches whole words, with the spelling the list gives', () => {
    expect(stackWords('JAVASCRIPT and typescript, not JavaScripty; Node.js; .NET; C# and C++.').sort()).toEqual(['.NET', 'C#', 'C++', 'JavaScript', 'Node.js', 'TypeScript'])
    expect(stackWords('NoSQL and PostgreSQL')).toEqual(['PostgreSQL'])
  })

  it('reads the words that are also English only as written', () => {
    expect(stackWords('Go beyond. Rust, Swift, Spark, Ruby, Express, React, Spring, Rails.').sort()).toEqual(['Express', 'Go', 'React', 'Ruby', 'Rails', 'Rust', 'Spark', 'Spring', 'Swift'].sort())
    expect(stackWords('go ahead and react to the spring rails; express yourself')).toEqual([])
  })
})
