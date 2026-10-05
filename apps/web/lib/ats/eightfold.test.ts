import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPolitenessState } from './http'
import { eightfold, eightfoldToken, splitEightfoldToken } from './eightfold'

vi.mock('../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

const fixture = (name: string) => readFileSync(path.join(__dirname, '../ingest/reader/__fixtures__', name), 'utf8')
const realFetch = globalThis.fetch

const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } })

// The fixtures are dated early October 2026; the 180-day rule is read against that day.
beforeEach(() => {
  resetPolitenessState()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('eightfold token', () => {
  it('splits host and domain once, and rejects what is not both', () => {
    expect(splitEightfoldToken('explore.jobs.netflix.net_netflix.com')).toEqual({ host: 'explore.jobs.netflix.net', domain: 'netflix.com' })
    expect(splitEightfoldToken('nodomain')).toBeNull()
    expect(splitEightfoldToken('evil.com/x_netflix.com')).toBeNull()
    expect(eightfoldToken('apply.careers.microsoft.com', 'microsoft.com')).toBe('apply.careers.microsoft.com_microsoft.com')
  })

  it('is detected from a vendor-hosted careers url that names its domain', () => {
    expect(eightfold.detect({ careerUrl: 'https://acme.eightfold.ai/careers?domain=acme.com', domain: null })).toEqual({
      token: 'acme.eightfold.ai_acme.com',
    })
    expect(eightfold.detect({ careerUrl: 'https://acme.eightfold.ai/careers', domain: null })).toBeNull()
  })
})

describe('eightfold adapter', () => {
  it('reads a v2 board (Netflix): title, url, date, requisition id', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/apply/v2/jobs/')) return json(fixture('netflix-detail.json'))
      return json(fixture('netflix-v2.json'))
    }) as unknown as typeof fetch

    const jobs = await eightfold.fetch('explore.jobs.netflix.net_netflix.com', { query: ['data engineer'] })

    expect(urls[0]).toContain('https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&query=data%20engineer&start=0')
    expect(jobs.length).toBe(5)
    expect(jobs[0]).toMatchObject({
      title: 'Staff Data Engineer (L6) - Ads',
      url: 'https://explore.jobs.netflix.net/careers/job/790318041617',
      requisitionId: 'JR42273',
      location: 'Remote, United States',
      postedAt: '2026-08-21T00:00:00.000Z',
    })
  })

  it('falls back to pcsx when v2 answers 403 (Microsoft), with relative urls made absolute', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/apply/v2/')) return new Response('forbidden', { status: 403 })
      if (url.includes('position_details')) return json(fixture('ms-detail.json'))
      return json(fixture('ms-pcsx.json'))
    }) as unknown as typeof fetch

    const jobs = await eightfold.fetch('apply.careers.microsoft.com_microsoft.com', { query: ['data engineer'] })

    expect(urls.some((u) => u.includes('/api/pcsx/search?domain=microsoft.com&query=data%20engineer'))).toBe(true)
    expect(jobs).toHaveLength(5)
    expect(jobs[0].url).toMatch(/^https:\/\/apply\.careers\.microsoft\.com\/careers\/job\/\d+$/)
    expect(jobs[0].requisitionId).toBeTruthy()
    expect(jobs[0].postedAt).toMatch(/^2026-/)
    // The search lists no body, so the first few get one from the detail call.
    expect(jobs.some((j) => (j.description ?? '').length > 100)).toBe(true)
  })

  it('stops paging at the cap: 5 pages per search word', async () => {
    const page = JSON.parse(fixture('netflix-v2.json')) as { count: number; positions: Record<string, unknown>[] }
    let calls = 0
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/apply/v2/jobs/')) return json('{}')
      const start = Number(new URL(url).searchParams.get('start'))
      calls++
      const positions = Array.from({ length: 10 }, (_, i) => ({
        ...page.positions[0],
        id: String(start + i + 1),
        canonicalPositionUrl: `https://explore.jobs.netflix.net/careers/job/${start + i + 1}`,
      }))
      return json(JSON.stringify({ count: 900, positions }))
    }) as unknown as typeof fetch

    const jobs = await eightfold.fetch('explore.jobs.netflix.net_netflix.com', { query: ['data'], sleep: async () => {} })
    expect(calls).toBe(5)
    expect(jobs).toHaveLength(50)
  })

  it('stops with what it has when the host says slow down mid-read', async () => {
    const page = JSON.parse(fixture('netflix-v2.json')) as { count: number; positions: Record<string, unknown>[] }
    let calls = 0
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/apply/v2/jobs/')) return json('{}')
      calls++
      if (calls > 2) return new Response('slow down', { status: 403 })
      const start = Number(new URL(url).searchParams.get('start'))
      const positions = Array.from({ length: 10 }, (_, i) => ({ ...page.positions[0], id: String(start + i + 1), canonicalPositionUrl: `https://explore.jobs.netflix.net/careers/job/${start + i + 1}` }))
      return json(JSON.stringify({ count: 900, positions }))
    }) as unknown as typeof fetch
    const jobs = await eightfold.fetch('explore.jobs.netflix.net_netflix.com', { query: ['data'], sleep: async () => {} })
    expect(jobs).toHaveLength(20)
  })

  it('refuses a token that is not a host and a domain', async () => {
    await expect(eightfold.fetch('netflix')).rejects.toThrow('invalid board token')
  })
})
