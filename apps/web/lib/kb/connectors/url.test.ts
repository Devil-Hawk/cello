import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const upsertDocumentMock = vi.fn(async (_client: unknown, _input: unknown) => ({ document: { id: 'doc-1' }, chunkCount: 2 }))
vi.mock('../store', () => ({ upsertDocument: (client: unknown, input: unknown) => upsertDocumentMock(client, input) }))

import type { KbSource } from '../types'
import { syncUrlSource } from './url'

const client = {} as SupabaseClient
const source = (url: string) => ({ id: 's1', label: 'link', config: { url } }) as unknown as KbSource

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]
const PRIVATE = [{ address: '10.0.0.1', family: 4 }]
const resolveBy = (table: Record<string, Array<{ address: string; family: number }>>) => async (host: string) => table[host] ?? PUBLIC

const page = () =>
  new Response('<html><head><title>About us</title></head><body><p>We make small tools for people who look for work.</p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } })

afterEach(() => {
  vi.unstubAllGlobals()
  upsertDocumentMock.mockClear()
})

describe('the link connector', () => {
  it('refuses a host that resolves to a private address, before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const out = await syncUrlSource(client, 'u1', source('https://notes.example.com/x'), { resolveHostname: resolveBy({ 'notes.example.com': PRIVATE }) })
    expect(out).toMatchObject({ status: 'error', message: 'Refusing to fetch a private/internal address.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a redirect to a host that resolves to a private address', async () => {
    const fetchMock = vi.fn(async (u: string) => (u === 'https://example.com/' ? redirect('https://www.example.com/') : page()))
    vi.stubGlobal('fetch', fetchMock)
    const out = await syncUrlSource(client, 'u1', source('https://example.com/'), { resolveHostname: resolveBy({ 'www.example.com': PRIVATE }) })
    expect(out).toMatchObject({ status: 'error', message: 'Refusing to fetch a private/internal address.' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a redirect to another site and a redirect that never ends', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirect('https://elsewhere.test/')))
    expect(await syncUrlSource(client, 'u1', source('https://example.com/'), { resolveHostname: resolveBy({}) })).toMatchObject({
      status: 'error',
      message: expect.stringContaining('cross-site redirect'),
    })
    vi.stubGlobal('fetch', vi.fn(async (u: string) => redirect(u.endsWith('/a') ? 'https://example.com/b' : 'https://example.com/a')))
    expect(await syncUrlSource(client, 'u1', source('https://example.com/a'), { resolveHostname: resolveBy({}) })).toMatchObject({
      status: 'error',
      message: 'Too many redirects.',
    })
  })

  it('refuses a literal local address', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const out = await syncUrlSource(client, 'u1', source('http://127.0.0.1:11434/'), { resolveHostname: resolveBy({}) })
    expect(out.status).toBe('error')
  })

  it('indexes a public page, following an apex to www hop', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (u === 'https://example.com/' ? redirect('https://www.example.com/about') : page())))
    const out = await syncUrlSource(client, 'u1', source('https://example.com/'), { resolveHostname: resolveBy({}) })
    expect(out).toMatchObject({ status: 'synced', chunksWritten: 2 })
    expect(upsertDocumentMock).toHaveBeenCalledWith(client, expect.objectContaining({ title: 'About us', sourceId: 's1' }))
  })
})
