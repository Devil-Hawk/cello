// POST /api/resume/documents { action: 'save' }: whichever body arrives, what
// is stored is a schema-valid structured Resume, and the response tells the
// editor what the structure made of its text.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const createResumeVersion = vi.fn()
vi.mock('@/lib/resume/store', () => ({
  createResumeVersion: (...a: unknown[]) => createResumeVersion(...a),
  deleteVersion: vi.fn(),
  getBaseResume: vi.fn().mockResolvedValue(null),
  getVersionById: vi.fn(),
  listVersions: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { full_name: 'Jordan Rivera', email: 'jr@example.com' }, error: null }),
        }),
      }),
    }),
  }),
}))
vi.mock('@/lib/access/session', () => ({ recordDemoEvent: async () => {} }))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({}) }))
vi.mock('@/lib/harness/agents/resume_optimizer', () => ({ optimizeResumeAndSave: vi.fn() }))
vi.mock('@/lib/harness/llm', () => ({ callLlm: vi.fn(), MissingKeyError: class extends Error {} }))
vi.mock('@/lib/resume/pdf', () => ({ renderResumeVersionPdf: vi.fn() }))
vi.mock('@/lib/resume/docx', () => ({ renderResumeVersionDocx: vi.fn() }))

import { POST } from './route'
import { ResumeSchema } from '@/lib/resume/schema'
import { CANONICAL_RESUME, PASTE_TEXT } from '@/lib/resume/test-fixtures'

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/resume/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  createResumeVersion.mockReset().mockImplementation(async (_c, input) => ({
    id: 'doc-1',
    version: 3,
    title: input.title,
    content_json: null,
  }))
})

describe('save with markdown (the editor)', () => {
  it('stores a schema-valid structured resume from pasted plain text and returns the canonical markdown', async () => {
    const res = await post({ action: 'save', jobId: null, markdown: PASTE_TEXT, templateId: 'classic', source: 'base' })
    expect(res.status).toBe(200)
    const body = await res.json()

    const input = createResumeVersion.mock.calls[0][1]
    expect(ResumeSchema.safeParse(input.resume).success).toBe(true)
    expect(input.resume.work).toHaveLength(3)
    expect(input.resume.meta.cello).toMatchObject({ templateId: 'classic', structuredBy: 'heuristic' })
    expect(input).not.toHaveProperty('content')

    expect(body.markdown).toMatch(/^## Experience$/m)
    expect(body.markdown).toMatch(/^### Senior Software Engineer, Northwind Analytics$/m)
    expect(body.tidied).toBe(true)
  })

  it('is stable: saving the canonical markdown again changes nothing', async () => {
    const first = await (await post({ action: 'save', jobId: null, markdown: PASTE_TEXT, source: 'base' })).json()
    const second = await (await post({ action: 'save', jobId: null, markdown: first.markdown, source: 'edited' })).json()
    expect(second.markdown).toBe(first.markdown)
    expect(second.tidied).toBe(false)
  })

  it('falls back to the profile name when the text has none', async () => {
    await post({ action: 'save', jobId: null, markdown: 'SUMMARY\nPlatform engineer.', source: 'base' })
    expect(createResumeVersion.mock.calls[0][1].resume.basics.name).toBe('Jordan Rivera')
  })

  it('rejects empty text', async () => {
    const res = await post({ action: 'save', jobId: null, markdown: '   ', source: 'base' })
    expect(res.status).toBe(400)
    expect(createResumeVersion).not.toHaveBeenCalled()
  })
})

describe('save with a resume (the import review sheet)', () => {
  it('stores it as given', async () => {
    const res = await post({ action: 'save', jobId: null, resume: CANONICAL_RESUME, source: 'base' })
    expect(res.status).toBe(200)
    expect(createResumeVersion.mock.calls[0][1].resume).toEqual(CANONICAL_RESUME)
    const body = await res.json()
    expect(body.tidied).toBe(false)
  })

  it('rejects a document that is not a valid resume, naming the field', async () => {
    const bad = { ...CANONICAL_RESUME, basics: { ...CANONICAL_RESUME.basics, name: '' } }
    const res = await post({ action: 'save', jobId: null, resume: bad, source: 'base' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/basics\.name/)
    expect(createResumeVersion).not.toHaveBeenCalled()
  })

  it('rejects an unknown source', async () => {
    const res = await post({ action: 'save', jobId: null, resume: CANONICAL_RESUME, source: 'bogus' })
    expect(res.status).toBe(400)
  })
})
