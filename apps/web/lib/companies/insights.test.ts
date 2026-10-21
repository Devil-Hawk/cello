import { describe, expect, it } from 'vitest'
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

  it('reports pay only as stated: the count, and the yearly range in the most common currency', () => {
    const i = computeInsights(
      [
        job('1', 'A', { salary: 'USD 140,000–240,000 / yr' }),
        job('2', 'B', { salary: 'USD 120,000–200,000 per year' }),
        job('3', 'C', { salary: 'EUR 90,000 per year' }),
        job('4', 'D', { salary: 'USD 60 per hour' }),
        job('5', 'E'),
      ],
      { now: NOW, closes: [] }
    )
    expect(i.pay).toEqual({ stated: 4, min: 120000, max: 240000, currency: 'USD' })
  })

  it('counts pay that states no yearly figure without inventing a range', () => {
    const i = computeInsights([job('1', 'A', { salary: 'Competitive' }), job('2', 'B', { salary: 'USD 60 per hour' })], { now: NOW, closes: [] })
    expect(i.pay).toEqual({ stated: 2, min: null, max: null, currency: null })
    expect(computeInsights([job('1', 'A')], { now: NOW, closes: [] }).pay).toEqual({ stated: 0, min: null, max: null, currency: null })
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
