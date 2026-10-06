// POST /api/applications/follow-up: the suggestion is the pipeline rule, the message is the Writer's.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let application: Record<string, unknown> | null
const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'a@example.com' } } }) },
  from: () => {
    const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: application, error: application ? null : { message: 'none' } }) }
    return chain
  },
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

const rows: Record<string, unknown> = { person_jobs: { company_id: 'c1' }, contacts: [{ id: 'k1', name: 'Sam' }] }
const admin = {
  from: (t: string) => {
    const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, single: async () => ({ data: rows[t] }), then: (r: (v: unknown) => void) => r({ data: rows[t] }) }
    return chain
  },
}
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/trace/job-input', () => ({ traceJobInput: async () => undefined }))

const writeMessageMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, written: { artifactId: 'a1', artifactVersion: 1, review: { body: 'Hi Sam, checking in.' } } }))
vi.mock('@/lib/outreach/write', () => ({ writeMessage: (...a: unknown[]) => writeMessageMock(...a) }))

import { POST } from './route'

const post = () => POST(new NextRequest('http://localhost/api/applications/follow-up', { method: 'POST', body: JSON.stringify({ applicationId: 'app-1' }) }))
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

beforeEach(() => {
  writeMessageMock.mockClear()
  application = { id: 'app-1', job_id: 'j1', stage: 'applied', applied_at: daysAgo(8) }
})

describe('application follow-up', () => {
  it("a due follow-up is the Writer's message with the contacts on file", async () => {
    const body = await (await post()).json()
    expect(body).toMatchObject({ draftMessage: 'Hi Sam, checking in.', suggestedContacts: ['Sam'] })
    expect(writeMessageMock).toHaveBeenCalledWith(expect.anything(), { id: 'u1', email: 'a@example.com' }, expect.objectContaining({ type: 'message', job_id: 'j1', contact_id: 'k1' }))
  })

  it('too soon: the suggestion answers and the Writer is not asked', async () => {
    application = { ...application, applied_at: daysAgo(1) }
    const body = await (await post()).json()
    expect(body.suggestion).toMatch(/too soon/i)
    expect(body.draftMessage).toBeUndefined()
    expect(writeMessageMock).not.toHaveBeenCalled()
  })

  it('a draft that cannot be written leaves the suggestion standing', async () => {
    writeMessageMock.mockResolvedValue({ ok: false, error: 'There is no resume on file.' })
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).draftMessage).toBeUndefined()
  })
})
