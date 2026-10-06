// Approvals: queue, decide, edit, stale, rules, and the fact that no agent has a send path.
// The send and submit code is mocked here; what matters is when, how many times, and by
// whom it is called. The stub that stands in for the real send path has its own case at the end.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendOutreach: vi.fn(), approveDraft: vi.fn(), scoreTrace: vi.fn(async () => undefined) }))
vi.mock('./send.stub', () => ({ sendOutreach: mocks.sendOutreach, approveDraft: mocks.approveDraft }))
vi.mock('@/lib/observability/langfuse', () => ({ scoreTrace: mocks.scoreTrace }))

import type { AgentContext } from './context'
import { addVersion, createArtifact } from './artifacts'
import { GMAIL_REAUTH_COPY, SKIPPED_COPY, STALE_COPY, autoApprove, decideApproval, hash, queueApproval, outcomeCopy, ruleAllows, takeUnpostedResults, type ApprovalRow } from './approvals'
import { makeFakeAdmin, type FakeAdmin } from './testing/fake-admin'

const user = { id: 'u1', email: 'dana@gmail.com', identities: [{ provider: 'google' }] }
const supabase = {} as never

function world() {
  const admin: FakeAdmin = makeFakeAdmin(
    {
      contacts: [
        { id: 'k1', user_id: 'u1', name: 'Dana Lee', email: 'dana@stripe.com', company_id: 'c1' },
        { id: 'k2', user_id: 'u1', name: 'No Email', email: null, company_id: 'c1' },
      ],
      jobs: [{ id: 'j1', company_id: 'c1', title: 'PM', companies: { user_id: 'u1' } }],
      outreach_messages: [],
      application_drafts: [],
      approvals: [],
    },
    {
      artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) },
      approvals: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ status: 'pending', posted_at: null, error: null, outcome: null }) },
      outreach_messages: { defaults: () => ({ kind: 'initial', parent_id: null, status: 'pending_review', sent_at: null }) },
    }
  )
  admin.rpcHandlers.artifact_add_version = async (args) => {
    const art = admin.tables.artifacts.find((r) => r.id === args.p_artifact_id && r.user_id === args.p_user_id)
    if (!art) throw new Error('artifact not found for this user')
    art.current_version = (art.current_version as number) + 1
    admin.tables.artifact_versions.push({ artifact_id: art.id, version: art.current_version, author: args.p_author, content: args.p_content, content_text: args.p_content_text })
    return art.current_version
  }
  const ctx: AgentContext = {
    admin,
    userId: 'u1',
    userEmail: 'dana@gmail.com',
    apiKeys: { openrouter: 'k', userId: 'u1' },
    isDemo: false,
    threadId: 't1',
    conversationId: 'conv1',
    autonomy: 'ask',
    traceId: 'trace-1',
    deadlineAt: Date.now() + 60_000,
  }
  return { admin, ctx }
}

async function email(admin: FakeAdmin, over: Record<string, unknown> = {}) {
  return createArtifact(admin, {
    userId: 'u1',
    type: 'outreach_email',
    title: 'Email to Dana',
    content: { subject: 'Billing at Acme', body: 'Hi Dana, I built billing at Acme. Could we talk?', to_name: 'Dana Lee', to_email: 'dana@stripe.com', kind: 'initial', ...over },
    author: 'cello',
    contactId: 'k1',
    jobId: 'j1',
    companyId: 'c1',
  })
}

const sentOk = (id: string) => ({ status: 200, body: { ok: true, message: { id, to_name: 'Dana Lee', to_email: 'dana@stripe.com', gmail_message_id: 'g1' } } })

beforeEach(() => {
  mocks.sendOutreach.mockReset()
  mocks.approveDraft.mockReset()
  mocks.scoreTrace.mockClear()
})

describe('queueApproval', () => {
  it('queues an email without sending it, and creates the message in pending review', async () => {
    const { admin, ctx } = world()
    const a = await email(admin)
    const r = await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 't1:call-1' })
    expect(r).toMatchObject({ ok: true, created: true })
    expect(mocks.sendOutreach).not.toHaveBeenCalled()
    const msg = admin.tables.outreach_messages[0]
    expect(msg).toMatchObject({ status: 'pending_review', to_email: 'dana@stripe.com', subject: 'Billing at Acme', contact_id: 'k1', job_id: 'j1', kind: 'initial' })
    const row = admin.tables.approvals[0]
    expect(row).toMatchObject({ status: 'pending', action: 'send_email', artifact_id: a.id, artifact_version: 1, target_table: 'outreach_messages', target_id: msg.id, trace_id: 'trace-1', thread_id: 't1' })
    expect(String(row.payload_hash)).toHaveLength(64)
  })

  it('from a tool server call with no conversation, stores no thread, never an empty id', async () => {
    const { admin, ctx } = world()
    const a = await email(admin)
    const r = await queueApproval({ ...ctx, threadId: '', conversationId: null }, { action: 'send_email', artifactId: a.id, idempotencyKey: 'mcp-1' })
    expect(r).toMatchObject({ ok: true, created: true })
    expect(admin.tables.approvals[0].thread_id).toBeNull()
  })

  it('is idempotent by key: a second call returns the same row and queues nothing new', async () => {
    const { admin, ctx } = world()
    const a = await email(admin)
    const first = await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 'k' })
    const second = await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 'k' })
    expect(second).toMatchObject({ ok: true, created: false })
    expect(second.ok && first.ok && second.approval.id === first.approval.id).toBe(true)
    expect(admin.tables.approvals).toHaveLength(1)
    expect(admin.tables.outreach_messages).toHaveLength(1)
  })

  it('refuses a contact with no email, an artifact that is not an email, and a duplicate', async () => {
    const { admin, ctx } = world()
    const a = await email(admin)
    expect(await queueApproval(ctx, { action: 'send_email', artifactId: a.id, contactId: 'k2', idempotencyKey: '1' })).toMatchObject({ ok: false, error: expect.stringContaining('no email address') })
    const letter = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'L', content: { text: 'x' }, author: 'cello' })
    expect(await queueApproval(ctx, { action: 'send_email', artifactId: letter.id, idempotencyKey: '2' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot be sent as an email') })
    expect((await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: '3' })).ok).toBe(true)
    const again = await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: '4' })
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('already waiting for approval') })
  })

  it('refuses another person\'s artifact and a missing one with the fix', async () => {
    const { admin, ctx } = world()
    const other = await createArtifact(admin, { userId: 'u2', type: 'outreach_email', title: 'x', content: { subject: 's', body: 'b' }, author: 'cello' })
    const r = await queueApproval(ctx, { action: 'send_email', artifactId: other.id, idempotencyKey: 'x' })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.fix).toMatch(/create_artifact/)
  })

  it('a demo cannot queue a send', async () => {
    const { admin, ctx } = world()
    ctx.isDemo = true
    const a = await email(admin)
    expect(await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 'd' })).toMatchObject({ ok: false, error: 'Demo accounts can draft but not send.' })
    expect(admin.tables.approvals).toHaveLength(0)
  })

  it('queues a follow-up only after the first email was sent, and only one', async () => {
    const { admin, ctx } = world()
    const a = await email(admin, { kind: 'follow_up' })
    expect(await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 'f1' })).toMatchObject({ ok: false, error: expect.stringContaining('nothing to follow up on') })
    admin.tables.outreach_messages.push({ id: 'm0', user_id: 'u1', contact_id: 'k1', kind: 'initial', status: 'sent', sent_at: '2026-10-01T00:00:00Z' })
    const ok = await queueApproval(ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 'f2' })
    expect(ok.ok).toBe(true)
    expect(admin.tables.outreach_messages.at(-1)).toMatchObject({ kind: 'follow_up', parent_id: 'm0' })
  })

  it('queues an application as a draft in pending review', async () => {
    const { admin, ctx } = world()
    const letter = await createArtifact(admin, { userId: 'u1', type: 'cover_letter', title: 'L', content: { text: 'Dear team' }, author: 'cello', jobId: 'j1' })
    const r = await queueApproval(ctx, { action: 'submit_application', artifactId: letter.id, idempotencyKey: 'a1' })
    expect(r.ok).toBe(true)
    expect(admin.tables.application_drafts[0]).toMatchObject({ job_id: 'j1', status: 'pending_review', cover_letter: 'Dear team' })
    expect(mocks.approveDraft).not.toHaveBeenCalled()
  })
})

async function queued(over: Record<string, unknown> = {}) {
  const w = world()
  const a = await email(w.admin)
  const q = await queueApproval(w.ctx, { action: 'send_email', artifactId: a.id, idempotencyKey: 'k' })
  if (!q.ok) throw new Error('setup failed')
  void over
  return { ...w, artifact: a, approval: q.approval }
}

const decide = (w: { admin: FakeAdmin }, id: string, extra: Record<string, unknown> = {}) =>
  decideApproval({ supabase, admin: w.admin, user, session: null, id, decision: 'approve', by: 'user', ...extra })

describe('decideApproval: approve', () => {
  it('runs the send once, stores its outcome, scores the trace and says what happened', async () => {
    const w = await queued()
    mocks.sendOutreach.mockImplementation(async (i: { readBody: () => Promise<{ id: string }> }) => sentOk((await i.readBody()).id))
    const r = await decide(w, w.approval.id)
    expect(mocks.sendOutreach).toHaveBeenCalledTimes(1)
    const input = mocks.sendOutreach.mock.calls[0][0]
    expect(await input.readBody()).toEqual({ id: w.approval.target_id, approve: true })
    expect(r.status).toBe(200)
    expect(r.approval).toMatchObject({ status: 'done', decided_by: 'user' })
    expect(r.approval?.outcome).toMatchObject({ what: 'Email sent to Dana Lee', artifact_version: 1, approval_id: w.approval.id })
    expect(r.copy).toMatch(/^Sent from dana@gmail.com at \d{1,2}:\d{2}\. Saved\.$/)
    expect(mocks.scoreTrace).toHaveBeenCalledWith('trace-1', 'draft_approved', 1, 'Email sent to Dana Lee')
  })

  it('called twice at once, it sends once', async () => {
    const w = await queued()
    mocks.sendOutreach.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15))
      return sentOk('m')
    })
    const [a, b] = await Promise.all([decide(w, w.approval.id), decide(w, w.approval.id)])
    expect(mocks.sendOutreach).toHaveBeenCalledTimes(1)
    // The winner has the outcome. The loser was told it is in progress, or read the winner's result.
    expect([a, b].filter((r) => r.approval?.status === 'done' && r.status === 200)).toHaveLength(1)
    expect([a, b].filter((r) => r.status === 409).length).toBeLessThanOrEqual(1)
    expect(w.admin.tables.approvals[0].status).toBe('done')
  })

  it('a repeat after it finished returns the stored outcome without sending again', async () => {
    const w = await queued()
    mocks.sendOutreach.mockResolvedValue(sentOk('m'))
    const first = await decide(w, w.approval.id)
    const again = await decide(w, w.approval.id)
    expect(mocks.sendOutreach).toHaveBeenCalledTimes(1)
    expect(again.status).toBe(200)
    expect(again.approval?.outcome).toEqual(first.approval?.outcome)
  })

  it('a failed send is recorded with what to do, and is not retried by a second click', async () => {
    const w = await queued()
    mocks.sendOutreach.mockResolvedValue({ status: 401, body: { error: 'Gmail rejected the saved access.', needsReauth: true } })
    const r = await decide(w, w.approval.id)
    expect(r.approval).toMatchObject({ status: 'failed', error: GMAIL_REAUTH_COPY })
    expect(r.copy).toBe(GMAIL_REAUTH_COPY)
    expect(mocks.scoreTrace).toHaveBeenCalledWith('trace-1', 'draft_skipped', 0, 'send failed')
    await decide(w, w.approval.id)
    expect(mocks.sendOutreach).toHaveBeenCalledTimes(1)
  })

  it('a refusal from the send guardrails (daily cap, demo) becomes a plain failure', async () => {
    const w = await queued()
    mocks.sendOutreach.mockResolvedValue({ status: 429, body: { error: 'Daily send limit reached (10).' } })
    const r = await decide(w, w.approval.id)
    expect(r.approval?.status).toBe('failed')
    expect(r.copy).toBe('Not sent: Daily send limit reached (10).')
  })

  it('refuses another person\'s approval', async () => {
    const w = await queued()
    const r = await decideApproval({ supabase, admin: w.admin, user: { id: 'u2' }, session: null, id: w.approval.id, decision: 'approve', by: 'user' })
    expect(r.status).toBe(404)
    expect(mocks.sendOutreach).not.toHaveBeenCalled()
  })
})

describe('decideApproval: edits and changed drafts', () => {
  it('an edit becomes a version by the person and the hash follows it', async () => {
    const w = await queued()
    mocks.sendOutreach.mockResolvedValue(sentOk('m'))
    const before = w.approval.payload_hash
    const r = await decide(w, w.approval.id, { edits: { body: 'Hi Dana, a shorter note. Could we talk?' } })
    expect(r.approval).toMatchObject({ status: 'done', artifact_version: 2 })
    expect(r.approval?.payload_hash).not.toBe(before)
    expect(w.admin.tables.artifact_versions.at(-1)).toMatchObject({ version: 2, author: 'user' })
    // The message the send path reads has the edit.
    expect(w.admin.tables.outreach_messages[0].body).toBe('Hi Dana, a shorter note. Could we talk?')
    expect(mocks.scoreTrace).toHaveBeenCalledWith('trace-1', 'draft_approved', 1, expect.any(String))
  })

  it('a draft that changed after it was queued is refused until the person has seen the new version', async () => {
    const w = await queued()
    await addVersion(w.admin, { userId: 'u1', artifactId: w.artifact.id, author: 'cello', content: { subject: 'New', body: 'Hi Dana, revised. Could we talk?', kind: 'initial' } })
    const refused = await decide(w, w.approval.id)
    expect(refused).toMatchObject({ status: 409, copy: STALE_COPY })
    expect(refused.fix).toMatch(/acknowledge_version 2/)
    expect(mocks.sendOutreach).not.toHaveBeenCalled()
    expect(w.admin.tables.approvals[0].status).toBe('pending')

    mocks.sendOutreach.mockResolvedValue(sentOk('m'))
    const ok = await decide(w, w.approval.id, { acknowledgeVersion: 2 })
    expect(ok.approval).toMatchObject({ status: 'done', artifact_version: 2 })
    expect(w.admin.tables.outreach_messages[0]).toMatchObject({ subject: 'New', body: 'Hi Dana, revised. Could we talk?' })
  })

  it('acknowledging the wrong version is still refused', async () => {
    const w = await queued()
    await addVersion(w.admin, { userId: 'u1', artifactId: w.artifact.id, author: 'cello', content: { subject: 'New', body: 'b b b b b b', kind: 'initial' } })
    expect((await decide(w, w.approval.id, { acknowledgeVersion: 1 })).status).toBe(409)
  })
})

describe('decideApproval: skip', () => {
  it('never calls send, marks the message skipped, and says nothing was sent', async () => {
    const w = await queued()
    const r = await decide(w, w.approval.id, { decision: 'skip' })
    expect(mocks.sendOutreach).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 200, copy: SKIPPED_COPY })
    expect(r.approval?.status).toBe('skipped')
    expect(w.admin.tables.outreach_messages[0].status).toBe('skipped')
    expect(mocks.scoreTrace).toHaveBeenCalledWith('trace-1', 'draft_skipped', 0)
  })

  it('a skipped approval cannot be approved afterwards', async () => {
    const w = await queued()
    await decide(w, w.approval.id, { decision: 'skip' })
    const r = await decide(w, w.approval.id)
    expect(r.copy).toBe(SKIPPED_COPY)
    expect(mocks.sendOutreach).not.toHaveBeenCalled()
  })
})

describe('applications', () => {
  it('approving runs the approve path once and records its outcome', async () => {
    const w = world()
    const letter = await createArtifact(w.admin, { userId: 'u1', type: 'cover_letter', title: 'L', content: { text: 'Dear team' }, author: 'cello', jobId: 'j1' })
    const q = await queueApproval(w.ctx, { action: 'submit_application', artifactId: letter.id, idempotencyKey: 'a' })
    if (!q.ok) throw new Error('setup')
    mocks.approveDraft.mockResolvedValue({ status: 200, body: { ok: true, status: 'submitted', provider: 'greenhouse', submissionRef: 'ref-1', handoffUrl: null } })
    const r = await decide(w, q.approval.id)
    expect(mocks.approveDraft).toHaveBeenCalledTimes(1)
    expect(mocks.approveDraft).toHaveBeenCalledWith({ admin: w.admin, userId: 'u1', draftId: q.approval.target_id })
    expect(r.approval?.outcome).toMatchObject({ what: 'Application submitted', result: { provider: 'greenhouse', submission_ref: 'ref-1' } })
  })

  it('a handoff says the person finishes on the company site', async () => {
    const w = world()
    const letter = await createArtifact(w.admin, { userId: 'u1', type: 'cover_letter', title: 'L', content: { text: 'Dear team' }, author: 'cello', jobId: 'j1' })
    const q = await queueApproval(w.ctx, { action: 'submit_application', artifactId: letter.id, idempotencyKey: 'a' })
    if (!q.ok) throw new Error('setup')
    mocks.approveDraft.mockResolvedValue({ status: 200, body: { ok: true, status: 'approved', handoffUrl: 'https://x.test/apply' } })
    const r = await decide(w, q.approval.id)
    expect(r.approval?.outcome?.what).toMatch(/Finish it on the company site/)
  })

  it('a failed submit is recorded, not hidden', async () => {
    const w = world()
    const letter = await createArtifact(w.admin, { userId: 'u1', type: 'cover_letter', title: 'L', content: { text: 'Dear team' }, author: 'cello', jobId: 'j1' })
    const q = await queueApproval(w.ctx, { action: 'submit_application', artifactId: letter.id, idempotencyKey: 'a' })
    if (!q.ok) throw new Error('setup')
    mocks.approveDraft.mockResolvedValue({ status: 200, body: { ok: true, status: 'failed', error: 'The form needs a work authorization answer.' } })
    const r = await decide(w, q.approval.id)
    expect(r.approval?.status).toBe('failed')
  })
})

describe('rules', () => {
  const row = (action: 'send_email' | 'submit_application') => ({ id: 'x', action }) as ApprovalRow

  it('only "act within my rules" can approve, and only what its rules name', () => {
    expect(ruleAllows({ autonomy: 'ask', rules: { allow_send_email: true } }, 'send_email')).toBe(false)
    expect(ruleAllows({ autonomy: 'draft', rules: { allow_send_email: true } }, 'send_email')).toBe(false)
    expect(ruleAllows({ autonomy: 'act', rules: {} }, 'send_email')).toBe(false)
    expect(ruleAllows({ autonomy: 'act', rules: { allow_send_email: true } }, 'send_email')).toBe(true)
  })

  it('never submits an application unless the rule says so, even with send allowed', () => {
    expect(ruleAllows({ autonomy: 'act', rules: { allow_send_email: true } }, 'submit_application')).toBe(false)
    expect(ruleAllows({ autonomy: 'act', rules: { allow_submit: true } }, 'submit_application')).toBe(true)
    void row
  })

  it('a task whose rules do not allow it leaves the approval pending and sends nothing', async () => {
    const w = await queued()
    const r = await autoApprove({ autonomy: 'draft', rules: {} }, w.approval, { supabase, admin: w.admin, user })
    expect(r).toBeNull()
    expect(mocks.sendOutreach).not.toHaveBeenCalled()
    expect(w.admin.tables.approvals[0].status).toBe('pending')
  })

  it('a task whose rules allow it approves through the same path, by rule', async () => {
    const w = await queued()
    mocks.sendOutreach.mockResolvedValue(sentOk('m'))
    const r = await autoApprove({ autonomy: 'act', rules: { allow_send_email: true } }, w.approval, { supabase, admin: w.admin, user })
    expect(r?.approval).toMatchObject({ status: 'done', decided_by: 'rule' })
    expect(mocks.sendOutreach).toHaveBeenCalledTimes(1)
  })
})

describe('telling the conversation', () => {
  it('returns each decided approval once, even when two turns start together', async () => {
    const w = await queued()
    mocks.sendOutreach.mockResolvedValue(sentOk('m'))
    await decide(w, w.approval.id)
    const [a, b] = await Promise.all([takeUnpostedResults(w.admin, 'u1', 't1'), takeUnpostedResults(w.admin, 'u1', 't1')])
    expect(a.length + b.length).toBe(1)
    expect((a[0] ?? b[0]).text).toMatch(/approved the email/)
    expect(await takeUnpostedResults(w.admin, 'u1', 't1')).toEqual([])
  })

  it('does not tell a pending approval', async () => {
    const w = await queued()
    expect(await takeUnpostedResults(w.admin, 'u1', 't1')).toEqual([])
  })

  it('does not tell another thread or another person', async () => {
    const w = await queued()
    await decide(w, w.approval.id, { decision: 'skip' })
    expect(await takeUnpostedResults(w.admin, 'u1', 'other-thread')).toEqual([])
    expect(await takeUnpostedResults(w.admin, 'u2', 't1')).toEqual([])
  })
})

describe('copy and hashing', () => {
  it('writes the outcome line', () => {
    const row = { action: 'send_email', outcome: { when: '2026-10-05T16:41:00Z', what: 'x' } } as ApprovalRow
    expect(outcomeCopy(row, 'dana@gmail.com')).toMatch(/^Sent from dana@gmail.com at \d{1,2}:41\. Saved\.$/)
  })

  it('hashes the same payload to the same value and a changed one to another', () => {
    expect(hash({ a: 1 })).toBe(hash({ a: 1 }))
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }))
  })
})

// --- no agent can send -----------------------------------------------------------

describe('no agent send path', () => {
  const root = path.join(process.cwd(), 'lib/agents')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = path.join(dir, e)
      return statSync(full).isDirectory() ? walk(full) : [full]
    })
  const files = walk(root).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
  const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join('/')

  it('only approvals.ts and its stub reach the send and submit code, and this scan sees real files', () => {
    expect(files.length).toBeGreaterThan(15)
    const offenders = files
      .filter((f) => rel(f) !== 'lib/agents/approvals.ts' && rel(f) !== 'lib/agents/send.stub.ts')
      .filter((f) => /sendOutreach|sendGmailMessage|approveDraft|lib\/outreach\/send|lib\/apply\/approve|lib\/outreach\/gmail|submitApplication|send\.stub/.test(readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('the scan would catch a file that did', () => {
    const fixture = `import { sendOutreach } from '@/lib/outreach/send'`
    expect(/sendOutreach|sendGmailMessage|approveDraft/.test(fixture)).toBe(true)
  })
})

// --- the stub -------------------------------------------------------------------

describe('until the command registry lands', () => {
  it('approving a send ends failed with the stub\'s sentence, and nothing is sent', async () => {
    const w = await queued()
    const stub = await vi.importActual<typeof import('./send.stub')>('./send.stub')
    mocks.sendOutreach.mockImplementation(stub.sendOutreach)
    const r = await decide(w, w.approval.id)
    expect(r.approval).toMatchObject({ status: 'failed', outcome: null })
    expect(r.copy).toContain('Not built yet: sending from an approval comes with the command registry')
    expect(w.admin.tables.approvals[0].status).toBe('failed')
    expect(w.admin.tables.outreach_messages[0].status).toBe('pending_review')
  })
})
