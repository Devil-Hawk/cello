// POST /api/outreach/follow-up: the reply gate. A reply the sync already
// recorded (replied_at) must stop the draft with no Gmail call, and an unknown
// reply state (no usable token) must refuse rather than draft.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { OutreachMessageRow } from '@/lib/outreach/types'

let user: { id: string; email: string } | null
let session: { provider_token?: string | null } | null
let parent: Partial<OutreachMessageRow> | null

const supabase = {
  auth: {
    getUser: async () => ({ data: { user } }),
    getSession: async () => ({ data: { session } }),
  },
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: { preferences: {}, full_name: 'Alex', resume_text: 'r', title: 'Staff', person_roles: [{ chance_detail: null }], name: 'Acme' } }),
    }
    return chain
  },
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/outreach/config', () => ({
  readOutreachConfig: async () => ({ prefs: { autoSend: false, dailyCap: 10, followUpDays: 5 }, userId: 'user-1' }),
}))

const insertOutreachMock = vi.fn(async (_c: unknown, row: Record<string, unknown>) => ({ id: 'fu-1', ...row }))
vi.mock('@/lib/outreach/store', () => ({
  getOutreach: async () => parent,
  findFollowUp: async () => null,
  insertOutreach: (...args: Parameters<typeof insertOutreachMock>) => insertOutreachMock(...args),
}))

const resolveTokenMock = vi.fn()
vi.mock('@/lib/gmail/token', () => ({ resolveGmailAccessToken: (...a: unknown[]) => resolveTokenMock(...a) }))
const threadHasReplyMock = vi.fn()
vi.mock('@/lib/outreach/gmail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outreach/gmail')>()),
  threadHasReply: (...a: unknown[]) => threadHasReplyMock(...a),
}))

let senderName: string | null = 'Alex Candidate'
vi.mock('@/lib/outreach/sources', () => ({
  loadOutreachSources: async () => ({
    senderName,
    companyId: 'co-1',
    hasHistory: true,
    input: {
      userEmail: 'alex@example.com',
      jobTitle: 'Staff Engineer',
      companyName: 'Acme',
      resumeText: 'Senior engineer.',
      jobDescription: 'Build things.',
      matchHighlights: [],
      facts: [],
      history: [{ id: 'H1', text: '2026-09-01 outreach_sent: Initial note' }],
      patterns: [],
    },
  }),
}))

interface ReviewFixture {
  subject: string
  body: string
  tokensUsed: number
  source: 'model' | 'template'
  templateReason?: string
  verdicts: unknown[]
  checks: { ok: boolean; checks: unknown[] }
  failed: boolean
  judgeUnavailable: boolean
}
let review: ReviewFixture
const writeMessageMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, written: { artifactId: 'art-1', artifactVersion: 1, review } }))
const discardMessageMock = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('@/lib/outreach/write', () => ({ writeMessage: (...a: unknown[]) => writeMessageMock(...a), discardMessage: (...a: unknown[]) => discardMessageMock(...a) }))
const writeVerdictMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/evals/verdicts', () => ({ writeVerdict: (...a: unknown[]) => writeVerdictMock(...a) }))

import { POST } from './route'
import { REPLY_CHECK_UNKNOWN_MESSAGE } from '@/lib/outreach/gmail'

const post = () =>
  POST(
    new NextRequest('http://localhost/api/outreach/follow-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: 'parent-1' }),
    })
  )

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'user-1', email: 'alex@example.com' }
  session = { provider_token: 'session-token' }
  parent = {
    id: 'parent-1',
    status: 'sent',
    kind: 'initial',
    sent_at: '2026-09-01T00:00:00Z',
    gmail_thread_id: 'th-1',
    replied_at: null,
    to_email: 'jordan@acme.com',
    to_name: 'Jordan',
    contact_id: 'c1',
    job_id: null,
    company_id: null,
  }
  resolveTokenMock.mockResolvedValue({ ok: true, accessToken: 'stored-token' })
  threadHasReplyMock.mockResolvedValue('none')
  senderName = 'Alex Candidate'
  review = {
    subject: 'Re: Staff',
    body: 'Hi again',
    tokensUsed: 12,
    source: 'model',
    verdicts: [],
    checks: { ok: true, checks: [] },
    failed: false,
    judgeUnavailable: false,
  }
  writeMessageMock.mockImplementation(async () => ({ ok: true, written: { artifactId: 'art-1', artifactVersion: 1, review } }))
  parent = { ...parent, subject: 'Staff Engineer at Acme', body: 'Hi Jordan,\n\nThe first email.\n\nThanks,\nAlex Candidate' }
})

describe('the reply gate', () => {
  it('stops at the replied_at the sync recorded, with no Gmail call and no draft', async () => {
    parent = { ...parent, replied_at: '2026-09-03T00:00:00Z' }

    const body = await (await post()).json()

    expect(body).toMatchObject({ ok: false, skipped: true, reason: 'contact already replied' })
    expect(threadHasReplyMock).not.toHaveBeenCalled()
    expect(writeMessageMock).not.toHaveBeenCalled()
  })

  it('refuses (fails closed) when no Gmail credential is usable, instead of drafting a chase it cannot vet', async () => {
    resolveTokenMock.mockResolvedValue({ ok: false, message: 'Gmail access not available.' })

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.needsReauth).toBe(true)
    expect(writeMessageMock).not.toHaveBeenCalled()
    expect(insertOutreachMock).not.toHaveBeenCalled()
  })

  it('checks the live thread with the resolved token and skips when the contact replied', async () => {
    threadHasReplyMock.mockResolvedValue('replied')

    const body = await (await post()).json()

    expect(threadHasReplyMock).toHaveBeenCalledWith('stored-token', 'th-1', 'alex@example.com')
    expect(body).toMatchObject({ ok: false, skipped: true })
    expect(insertOutreachMock).not.toHaveBeenCalled()
  })

  it('does not call a Gmail 403 on the thread "already replied": it explains the missing permission and drafts nothing', async () => {
    const realFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue(new Response('insufficient scopes', { status: 403 })) as unknown as typeof fetch
    const actual = await vi.importActual<typeof import('@/lib/outreach/gmail')>('@/lib/outreach/gmail')
    threadHasReplyMock.mockImplementation(actual.threadHasReply)
    try {
      const res = await post()
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toBe(REPLY_CHECK_UNKNOWN_MESSAGE)
      expect(body.skipped).toBeUndefined()
      expect(writeMessageMock).not.toHaveBeenCalled()
      expect(insertOutreachMock).not.toHaveBeenCalled()
    } finally {
      global.fetch = realFetch
    }
  })

  it('drafts the follow-up into review when there is no reply, recording whether a model wrote it', async () => {
    const res = await (await post()).json()

    expect(res.ok).toBe(true)
    expect(insertOutreachMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'follow_up', parent_id: 'parent-1', status: 'pending_review', used_llm: true, template_reason: null })
    )
  })
})

describe('what the follow-up is written from', () => {
  it('asks the Writer for a follow-up to this contact and role, and queues the version it saved', async () => {
    await post()

    expect(writeMessageMock).toHaveBeenCalledWith(expect.anything(), { id: 'user-1', email: 'alex@example.com' }, { type: 'follow_up', job_id: undefined, contact_id: 'c1' })
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ artifact_id: 'art-1', artifact_version: 1 }))
  })

  it('gets the same verdict rows as the first email', async () => {
    await post()

    expect(writeVerdictMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ judge: 'deterministic', subjectId: 'fu-1' }))
  })

  it('answers 409 needsName with no draft when the profile has no full name', async () => {
    senderName = null
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).needsName).toBe(true)
    expect(writeMessageMock).not.toHaveBeenCalled()
  })

  it('stores a template with its reason so the card can say so', async () => {
    review = { ...review, source: 'template', templateReason: 'provider_error', tokensUsed: 0 }
    const body = await (await post()).json()
    expect(body).toMatchObject({ usedLlm: false, templateReason: 'provider_error' })
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ used_llm: false, template_reason: 'provider_error' }))
  })
})
