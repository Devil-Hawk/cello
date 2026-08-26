import { describe, expect, it, vi, beforeEach } from 'vitest'

const upsertDocumentMock = vi.fn(async (_client: unknown, _input: unknown) => ({ document: { id: 'doc-1' }, chunkCount: 1 }))
const createSourceMock = vi.fn(async (_client: unknown, input: { userId: string; kind: string; label?: string | null }) => ({
  id: 'src-new',
  user_id: input.userId,
  kind: input.kind,
  label: input.label ?? null,
  config: null,
  enabled: true,
  last_synced_at: null,
  last_error: null,
  created_at: new Date().toISOString(),
}))

vi.mock('./store', () => ({
  upsertDocument: (client: unknown, input: unknown) => upsertDocumentMock(client, input),
  createSource: (client: unknown, input: { userId: string; kind: string; label?: string | null }) =>
    createSourceMock(client, input),
}))

import { ingestCompanyPage, ingestDossierSummary, readFreshCompanyPages } from './ingest'
import type { SupabaseClient } from '@supabase/supabase-js'

/** kb_sources lookup only — the one raw table query ingest.ts issues itself. */
function fakeSourcesAdmin(existingSourceId: string | null) {
  return {
    from: (table: string) => {
      if (table !== 'kb_sources') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: existingSourceId ? { id: existingSourceId } : null, error: null }),
              }),
            }),
          }),
        }),
      }
    },
  } as unknown as SupabaseClient
}

beforeEach(() => {
  upsertDocumentMock.mockClear()
  createSourceMock.mockClear()
})

describe('ingestCompanyPage / ingestDossierSummary — identity and idempotency', () => {
  it('re-ingesting the same page keeps the SAME external_id (store.ts replaces, never duplicates)', async () => {
    const admin = fakeSourcesAdmin('src-1')
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'home', 'first fetch')
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'home', 'second fetch, different text')

    expect(upsertDocumentMock).toHaveBeenCalledTimes(2)
    const externalIds = upsertDocumentMock.mock.calls.map((c) => (c[1] as { externalId: string }).externalId)
    expect(externalIds).toEqual(['company-1:home', 'company-1:home'])
  })

  it('different pages of the same company get different external_ids', async () => {
    const admin = fakeSourcesAdmin('src-1')
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'home', 'x')
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'about', 'y')
    const externalIds = upsertDocumentMock.mock.calls.map((c) => (c[1] as { externalId: string }).externalId)
    expect(externalIds).toEqual(['company-1:home', 'company-1:about'])
  })

  it('ingestDossierSummary keys on ":dossier" and stamps company_id', async () => {
    const admin = fakeSourcesAdmin('src-2')
    await ingestDossierSummary(admin, 'user-1', 'company-1', 'Acme makes widgets.')
    expect(upsertDocumentMock).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ externalId: 'company-1:dossier', companyId: 'company-1', content: 'Acme makes widgets.' })
    )
  })

  it('reuses an existing auto-provisioned source rather than creating a new one', async () => {
    const admin = fakeSourcesAdmin('src-existing')
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'home', 'text')
    expect(createSourceMock).not.toHaveBeenCalled()
    expect(upsertDocumentMock.mock.calls[0][1]).toMatchObject({ sourceId: 'src-existing' })
  })

  it('creates the auto source on first use', async () => {
    const admin = fakeSourcesAdmin(null)
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'home', 'text')
    expect(createSourceMock).toHaveBeenCalledWith(admin, {
      userId: 'user-1',
      kind: 'company_site',
      label: 'Company pages',
      enabled: true,
    })
  })

  it('no-ops on blank text without touching the store', async () => {
    const admin = fakeSourcesAdmin('src-1')
    await ingestCompanyPage(admin, 'user-1', 'company-1', 'careers', '   ')
    expect(upsertDocumentMock).not.toHaveBeenCalled()
  })
})

// --- readFreshCompanyPages ---------------------------------------------------

function fakeDocsAdmin(rows: { external_id: string; content: string; updated_at: string }[]) {
  return {
    from: (table: string) => {
      if (table !== 'kb_documents') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: rows, error: null }),
            }),
          }),
        }),
      }
    },
  } as unknown as SupabaseClient
}

const DAY_MS = 24 * 60 * 60 * 1000
const fresh = new Date(Date.now() - 1 * DAY_MS).toISOString()
const stale = new Date(Date.now() - 20 * DAY_MS).toISOString()

describe('readFreshCompanyPages — absent-or-stale falls through to a live fetch', () => {
  it('returns null when nothing is stored yet', async () => {
    const admin = fakeDocsAdmin([])
    expect(await readFreshCompanyPages(admin, 'user-1', 'company-1', 'acme.com')).toBeNull()
  })

  it('returns null when any stored page is older than the freshness window', async () => {
    const admin = fakeDocsAdmin([
      { external_id: 'company-1:home', content: 'home text', updated_at: fresh },
      { external_id: 'company-1:about', content: 'about text', updated_at: stale },
    ])
    expect(await readFreshCompanyPages(admin, 'user-1', 'company-1', 'acme.com')).toBeNull()
  })

  it('returns stored pages with reconstructed URLs when everything on file is fresh', async () => {
    const admin = fakeDocsAdmin([
      { external_id: 'company-1:home', content: 'home text', updated_at: fresh },
      { external_id: 'company-1:careers', content: 'careers text', updated_at: fresh },
    ])
    const pages = await readFreshCompanyPages(admin, 'user-1', 'company-1', 'acme.com')
    expect(pages).toEqual([
      { url: 'https://acme.com', text: 'home text' },
      { url: 'https://acme.com/careers', text: 'careers text' },
    ])
  })

  it('a partial-but-fresh set (no /about ever ingested) is returned as-is, not forced stale', async () => {
    const admin = fakeDocsAdmin([{ external_id: 'company-1:home', content: 'home text', updated_at: fresh }])
    const pages = await readFreshCompanyPages(admin, 'user-1', 'company-1', 'acme.com')
    expect(pages).toEqual([{ url: 'https://acme.com', text: 'home text' }])
  })
})
