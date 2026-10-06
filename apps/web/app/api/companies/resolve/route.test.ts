// "Atlas" typed by name must not come back as "Ashby board found" with a career
// page: a slug that exists says nothing about who owns it.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
const llm = vi.hoisted(() => ({ keys: {} as Record<string, string>, answer: '' }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => llm.keys }))
vi.mock('@/lib/harness/llm', async (orig) => ({ ...(await orig<object>()), callLlm: async () => ({ content: llm.answer }) }))
vi.mock('@/lib/trace/spans', () => ({ withTrace: async (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn() }))

import { POST } from './route'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function post(name: string) {
  return POST(new Request('http://x/api/companies/resolve', { method: 'POST', body: JSON.stringify({ name }) }) as never)
}

describe('POST /api/companies/resolve', () => {
  it('offers a guessed board as a possible match with its declared name and site, never as a career page', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === 'https://jobs.ashbyhq.com/atlas') {
        return new Response('<script>{"name":"Atlas Card","publicWebsite":"https://atlascard.com/"}</script>', { status: 200 })
      }
      return new Response('nope', { status: 404, statusText: 'Not Found' })
    }) as unknown as typeof fetch
    const body = await (await post('Atlas')).json()
    expect(body.candidates).toHaveLength(1)
    expect(body.candidates[0]).toMatchObject({
      name: 'Atlas Card',
      domain: 'atlascard.com',
      careerUrl: null,
      source: 'possible',
    })
    expect(body.candidates[0].note).toContain('Atlas Card')
  })

  it('offers nothing for a slug whose board says nothing about itself', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html></html>', { status: 200 })) as unknown as typeof fetch
    const body = await (await post('Zzyzx')).json()
    expect(body.candidates).toEqual([])
  })

  it('never fetches an internal address a model suggests as a careers page', async () => {
    llm.keys = { openrouter: 'k' }
    llm.answer = JSON.stringify({ officialDomain: 'zzyzx.example', careerUrl: 'http://169.254.169.254/latest/meta-data/jobs' })
    const fetched: string[] = []
    globalThis.fetch = vi.fn(async (input: unknown) => {
      fetched.push(String(input))
      return new Response('<html></html>', { status: 200 })
    }) as unknown as typeof fetch
    const body = await (await post('Zzyzx')).json()
    llm.keys = {}
    expect(body.candidates).toEqual([])
    expect(fetched.some((u) => u.includes('169.254.169.254'))).toBe(false)
  })
})
