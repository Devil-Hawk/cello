// What each tool does when it is called: the shapes it returns, the errors it gives, and the
// rules it keeps (only the person's own words become memory, nothing here sends, an agent
// cannot turn on acting by itself).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'

const m = vi.hoisted(() => ({
  shortlistFor: vi.fn(),
  recordReaction: vi.fn(),
  roleView: vi.fn(),
  runScout: vi.fn(),
  runWriter: vi.fn(),
  searchMemories: vi.fn(),
  runResearcher: vi.fn(),
  researchOneCompany: vi.fn(),
  doSearchKb: vi.fn(),
  getApplication: vi.fn(),
  loadOwnedCompany: vi.fn(),
  resolveCompany: vi.fn(),
  proposeLearning: vi.fn(),
  sourceContacts: vi.fn(),
  queueApproval: vi.fn(),
  autoApprove: vi.fn(),
  scoreTrace: vi.fn(async () => undefined),
}))

vi.mock('../scoring-port', async (orig) => ({ ...(await orig<typeof import('../scoring-port')>()), shortlistFor: m.shortlistFor, recordReaction: m.recordReaction, roleView: m.roleView }))
vi.mock('../subagents/scout', async (orig) => ({ ...(await orig<typeof import('../subagents/scout')>()), runScout: m.runScout }))
vi.mock('../subagents/writer', async (orig) => ({ ...(await orig<typeof import('../subagents/writer')>()), runWriter: m.runWriter }))
vi.mock('@/lib/memory/mem0-store', () => ({ getMemoryStore: () => ({ search: m.searchMemories }) }))
vi.mock('../run', () => ({ runResearcher: m.runResearcher }))
vi.mock('@/lib/harness/copilot-tools', async (orig) => ({
  ...(await orig<typeof import('@/lib/harness/copilot-tools')>()),
  researchOneCompany: m.researchOneCompany,
  doSearchKb: m.doSearchKb,
  getApplication: m.getApplication,
  loadOwnedCompany: m.loadOwnedCompany,
}))
vi.mock('@/lib/entities/companies', () => ({ resolveCompany: m.resolveCompany }))
vi.mock('@/lib/learning/read', () => ({ readLearnings: async () => ({ ok: true, items: [{ kind: 'preference', statement: 'Prefers small teams' }] }) }))
vi.mock('@/lib/learning/store', async (orig) => ({ ...(await orig<typeof import('@/lib/learning/store')>()), proposeLearning: m.proposeLearning }))
vi.mock('@/lib/contacts/sources', () => ({ sourceContactsForCompany: m.sourceContacts }))
vi.mock('@/lib/contacts/keys', () => ({ readContactProviderKeys: async () => ({ hunter: null, apollo: null }) }))
vi.mock('../approvals', async (orig) => ({ ...(await orig<typeof import('../approvals')>()), queueApproval: m.queueApproval, autoApprove: m.autoApprove }))
vi.mock('@/lib/observability/langfuse', () => ({ scoreTrace: m.scoreTrace }))

import type { AgentContext } from '../context'
import { BudgetCapError } from '../spend-port'
import { makeFakeAdmin, type FakeAdmin } from '../testing/fake-admin'
import { isToolFix, type ToolMeta } from './common'
import { toAgentTools } from './langchain'
import { scheduleTask } from './actions'
import { toolByName } from './registry'
import { quoteIsTheirs } from './memory'

function ctxFor(admin: FakeAdmin = makeFakeAdmin(), over: Partial<AgentContext> = {}): AgentContext {
  return {
    admin,
    userId: 'u1',
    userEmail: 'dana@example.com',
    apiKeys: { openrouter: 'k', userId: 'u1' },
    isDemo: false,
    threadId: 't1',
    conversationId: 'c1',
    autonomy: 'ask',
    traceId: 'trace-1',
    deadlineAt: Date.now() + 60_000,
    ...over,
  }
}

const meta = (over: Partial<ToolMeta> = {}): ToolMeta => ({ toolCallId: 'call-1', channel: 'agent', messages: [], ...over })

async function call(name: string, args: Record<string, unknown>, ctx: AgentContext, metaOver: Partial<ToolMeta> = {}) {
  // The scheduling tool is not offered while scheduled tasks are closed, but it is kept working.
  const def = name === 'schedule_task' ? scheduleTask : toolByName(name)!
  return def.handler(ctx, def.schema.parse(args) as never, meta(metaOver))
}

const pick = (id: string, over = {}) => ({ jobId: id, title: `Role ${id}`, company: `Co ${id}`, companyId: `c-${id}`, location: 'Seattle', postedAt: '2026-10-01', url: `https://x.test/${id}`, chance: 'strong', reason: 'You built billing.', gaps: ['No Go'], exploration: false, ...over })

beforeEach(() => {
  for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.()
  m.scoreTrace.mockResolvedValue(undefined)
})

describe('find_roles', () => {
  it('reads what is tracked by default and never sources', async () => {
    m.shortlistFor.mockResolvedValue({ picks: [pick('j1'), pick('j2', { exploration: true })], pool: 9, assessedNow: 0 })
    const out = (await call('find_roles', { query: 'pm' }, ctxFor())) as { count: number; of: number; roles: Record<string, unknown>[] }
    expect(m.runScout).not.toHaveBeenCalled()
    expect(m.shortlistFor.mock.calls[0][0]).toMatchObject({ query: 'pm', limit: 10, assessMissing: 0 })
    expect(out).toMatchObject({ count: 2, of: 9 })
    expect(out.roles[0]).toEqual({ id: 'j1', title: 'Role j1', company: 'Co j1', chance: 'strong', reason: 'You built billing.' })
    expect(out.roles[1]).toMatchObject({ exploration: true })
  })

  it('detailed adds the fields a follow-up question needs, concise does not', async () => {
    m.shortlistFor.mockResolvedValue({ picks: [pick('j1')], pool: 1, assessedNow: 0 })
    const detailed = (await call('find_roles', { response_format: 'detailed' }, ctxFor())) as { roles: Record<string, unknown>[] }
    expect(detailed.roles[0]).toMatchObject({ company_id: 'c-j1', location: 'Seattle', link: 'https://x.test/j1', gaps: ['No Go'] })
    const concise = (await call('find_roles', {}, ctxFor())) as { roles: Record<string, unknown>[] }
    expect(concise.roles[0]).not.toHaveProperty('link')
  })

  it('says what to do when nothing matches', async () => {
    m.shortlistFor.mockResolvedValue({ picks: [], pool: 0, assessedNow: 0 })
    expect(await call('find_roles', {}, ctxFor())).toMatchObject({ count: 0, note: expect.stringContaining('fresh') })
  })

  it('fresh sends the Scout out, with a key, and reports partial work honestly', async () => {
    m.runScout.mockResolvedValue({ status: 'partial', artifact_id: 'a1', picks: [{ id: 'j1', title: 'PM', company: 'Stripe', chance: 'strong', reason: 'x', exploration: false }], sourced: { found: 30, inserted: 12, summary: 's' }, note: 'Some sources did not finish.' })
    const out = (await call('find_roles', { query: 'pm', fresh: true, limit: 25 }, ctxFor())) as Record<string, unknown>
    const brief = m.runScout.mock.calls[0][1]
    expect(brief).toMatchObject({ query: 'pm', fresh: true, limit: 15, idempotency_key: 't1:call-1' })
    expect(out).toMatchObject({ count: 1, artifact_id: 'a1', partial: true, note: 'Some sources did not finish.' })
  })

  it('a failed search is an error with a fix', async () => {
    m.runScout.mockResolvedValue({ status: 'failed', error: 'No resume.', fix: 'Ask for one.' })
    const out = await call('find_roles', { fresh: true }, ctxFor())
    expect(out).toEqual({ error: 'No resume.', fix: 'Ask for one.' })
  })
})

describe('get_role and triage_role', () => {
  it('a missing role says how to get a real id', async () => {
    m.roleView.mockResolvedValue(null)
    const out = await call('get_role', { id: 'nope' }, ctxFor())
    expect(isToolFix(out)).toBe(true)
    expect(out).toMatchObject({ error: 'No role with id nope.', fix: expect.stringContaining('find_roles') })
  })

  it('never returns the posting text, and trims the lists to the limit', async () => {
    m.roleView.mockResolvedValue({ ...pick('j1'), assessed: true, salary: '$150k', requirements: { covered: ['a', 'b', 'c'], missing: ['d', 'e', 'f'] }, description: 'SECRET' })
    const detailed = (await call('get_role', { id: 'j1', response_format: 'detailed', limit: 2 }, ctxFor())) as Record<string, unknown>
    expect(detailed.covered).toEqual(['a', 'b'])
    expect(detailed.missing).toEqual(['d', 'e'])
    expect(JSON.stringify(detailed)).not.toContain('SECRET')
    const concise = (await call('get_role', { id: 'j1' }, ctxFor())) as Record<string, unknown>
    expect(concise).not.toHaveProperty('covered')
  })

  it('an unassessed role says so', async () => {
    m.roleView.mockResolvedValue({ ...pick('j1', { chance: null }), assessed: false, salary: null, requirements: { covered: [], missing: [] } })
    expect(await call('get_role', { id: 'j1' }, ctxFor())).toMatchObject({ note: expect.stringContaining('Not assessed') })
  })

  it('triage records the reaction and scores the trace for applied and not for me', async () => {
    m.recordReaction.mockResolvedValue({ ok: true, outcome: { what: 'Marked as applied.', reaction: 'applied', jobId: 'j1' } })
    expect(await call('triage_role', { id: 'j1', reaction: 'applied' }, ctxFor())).toMatchObject({ ok: true, what: 'Marked as applied.' })
    expect(m.scoreTrace).toHaveBeenCalledWith('trace-1', 'job_applied', 1, undefined)
    m.recordReaction.mockResolvedValue({ ok: true, outcome: { what: 'Marked as not for you.', reaction: 'not_for_me', jobId: 'j2' } })
    await call('triage_role', { id: 'j2', reaction: 'not_for_me', reason: 'Too big' }, ctxFor())
    expect(m.scoreTrace).toHaveBeenCalledWith('trace-1', 'job_dismissed', 0, 'Too big')
    m.scoreTrace.mockClear()
    await call('triage_role', { id: 'j3', reaction: 'interested' }, ctxFor())
    expect(m.scoreTrace).not.toHaveBeenCalled()
  })

  it('a role that is not the persons is an error with a fix', async () => {
    m.recordReaction.mockResolvedValue({ ok: false, error: 'No role with id x.', fix: 'Call find_roles.' })
    expect(await call('triage_role', { id: 'x', reaction: 'interested' }, ctxFor())).toEqual({ error: 'No role with id x.', fix: 'Call find_roles.' })
  })
})

describe('research', () => {
  const dossierWorld = () =>
    makeFakeAdmin(
      { company_dossiers: [{ id: 'd1', company_id: 'c1', user_id: 'u1', summary: 'Stripe builds payments.', sponsors_visa: 'likely', sources: [{ title: 'About', url: 'https://stripe.com/about' }] }] },
      { artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) } }
    )

  it('a tracked company on quick reads the saved record and saves a dossier artifact', async () => {
    const admin = dossierWorld()
    m.resolveCompany.mockResolvedValue({ id: 'c1', name: 'Stripe' })
    m.researchOneCompany.mockResolvedValue({ status: 'researched', company: 'Stripe', partial: false, reason: 'Dossier saved.' })
    const out = (await call('research', { subjects: ['Stripe'] }, ctxFor(admin))) as { ok: number; results: Record<string, unknown>[] }
    expect(out.ok).toBe(1)
    expect(out.results[0]).toMatchObject({ subject: 'Stripe', status: 'ok', summary: 'Stripe builds payments.', sponsors_visa: 'likely', sources: 1 })
    expect(admin.tables.artifacts[0]).toMatchObject({ type: 'dossier', company_id: 'c1', title: 'Research on Stripe' })
    expect(m.runResearcher).not.toHaveBeenCalled()
  })

  it('six subjects are one call with a result for each, and one failure does not sink the rest', async () => {
    const admin = dossierWorld()
    m.resolveCompany.mockResolvedValue({ id: 'c1', name: 'Stripe' })
    m.researchOneCompany.mockImplementation(async (_c: unknown, id: string) => ({ status: 'researched', company: 'Stripe', partial: false, reason: 'ok', id }))
    let n = 0
    m.researchOneCompany.mockImplementation(async () => {
      n += 1
      if (n === 3) return { status: 'error', companyId: 'c1', company: 'Stripe', reason: 'Site did not load' }
      return { status: 'researched', company: 'Stripe', partial: false, reason: 'ok' }
    })
    const out = (await call('research', { subjects: ['A', 'B', 'C', 'D', 'E', 'F'] }, ctxFor(admin))) as { requested: number; ok: number; failed: number; results: { status: string; error?: string }[]; note?: string }
    expect(out).toMatchObject({ requested: 6, ok: 5, failed: 1 })
    expect(out.results.filter((r) => r.status === 'failed')).toHaveLength(1)
    expect(out.note).toMatch(/did not finish/)
    // The tree has one parent line and a row per subject.
    const parent = admin.tables.agent_tasks?.find((r) => r.parent_id === null && r.agent === 'researcher')
    expect(parent?.title).toBe('Researching 6 companies (5 done, 1 failed)')
    expect(admin.tables.agent_tasks.filter((r) => r.parent_id === parent?.id)).toHaveLength(6)
  })

  it('an untracked company, a person and a topic go to the Researcher, and an answer without enough sources is said so', async () => {
    const admin = dossierWorld()
    m.resolveCompany.mockResolvedValue(null)
    m.runResearcher
      .mockResolvedValueOnce({ summary: 'Northwind sells shipping software.', sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }], enough_information: true, hit_step_limit: false })
      .mockResolvedValueOnce({ summary: '', sources: [{ url: 'https://c.test' }], enough_information: false, hit_step_limit: false })
    const out = (await call('research', { subjects: ['Northwind', 'Obscure Co'], depth: 'deep' }, ctxFor(admin))) as { results: Record<string, unknown>[] }
    expect(out.results[0]).toMatchObject({ status: 'ok', summary: 'Northwind sells shipping software.', sources: 2 })
    expect(out.results[1]).toMatchObject({ status: 'ok', note: 'Not enough public information to say anything reliable.' })
    expect(out.results[1]).not.toHaveProperty('artifact_id', expect.any(String))
    expect(admin.tables.artifacts).toHaveLength(1)
  })

  it('a researcher that ran out of steps is partial for steps', async () => {
    const admin = dossierWorld()
    m.resolveCompany.mockResolvedValue(null)
    m.runResearcher.mockResolvedValue({ summary: '', sources: [], enough_information: false, hit_step_limit: true })
    const out = (await call('research', { subjects: ['Slow Co'], kind: 'topic' }, ctxFor(admin))) as { partial: number; results: { status: string; reason?: string }[] }
    expect(out.partial).toBe(1)
    expect(out.results[0]).toMatchObject({ status: 'partial', reason: 'steps' })
  })

  it('a budget stop in a branch is partial for budget, not a failure', async () => {
    const admin = dossierWorld()
    m.resolveCompany.mockResolvedValue(null)
    m.runResearcher.mockRejectedValue(new BudgetCapError(10, 10))
    const out = (await call('research', { subjects: ['X'] }, ctxFor(admin))) as { results: { status: string; reason?: string }[] }
    expect(out.results[0]).toMatchObject({ status: 'partial', reason: 'budget' })
  })

  it('no more than eight subjects are accepted', () => {
    const def = toolByName('research')!
    expect(def.schema.safeParse({ subjects: Array.from({ length: 9 }, (_, i) => `c${i}`) }).success).toBe(false)
    expect(def.schema.safeParse({ subjects: [] }).success).toBe(false)
  })
})

describe('people and search_knowledge', () => {
  const world = () =>
    makeFakeAdmin({
      contacts: [
        { id: 'k1', user_id: 'u1', company_id: 'c1', name: 'Dana Lee', title: 'Recruiter', email: 'dana@stripe.com', verified: true, source: 'hunter', confidence: 0.9, basis: 'pattern' },
        { id: 'k2', user_id: 'u1', company_id: 'c1', name: 'Sam Rivera', title: 'Engineering Manager', email: null, verified: false },
        { id: 'k3', user_id: 'u2', company_id: 'c1', name: 'Not Mine', title: 'Recruiter', email: 'x@y.com', verified: true },
      ],
    })

  it('lists the persons contacts with an email status and no addresses unless detailed', async () => {
    m.loadOwnedCompany.mockResolvedValue({ company: { id: 'c1', name: 'Stripe', domain: 'stripe.com' } })
    const out = (await call('people', { company_id: 'c1' }, ctxFor(world()))) as { people: Record<string, unknown>[] }
    expect(out.people.map((p) => [p.name, p.email_status])).toEqual([['Dana Lee', 'verified'], ['Sam Rivera', 'none']])
    expect(JSON.stringify(out)).not.toContain('dana@stripe.com')
    const detailed = (await call('people', { company_id: 'c1', response_format: 'detailed' }, ctxFor(world()))) as { people: Record<string, unknown>[] }
    expect(detailed.people[0]).toMatchObject({ email: 'dana@stripe.com', source: 'hunter' })
  })

  it('filters by role and says what to do with no one', async () => {
    m.loadOwnedCompany.mockResolvedValue({ company: { id: 'c1', name: 'Stripe', domain: null } })
    const out = (await call('people', { company_id: 'c1', role: 'recruiter' }, ctxFor(world()))) as { people: unknown[] }
    expect(out.people).toHaveLength(1)
    m.sourceContacts.mockResolvedValue({})
    const empty = (await call('people', { company_id: 'c1', role: 'astronaut' }, ctxFor(world()))) as { note?: string }
    expect(empty.note).toMatch(/No saved contact has a title containing "astronaut"/)
    const none = (await call('people', { company_id: 'c9' }, ctxFor(makeFakeAdmin({ contacts: [] })))) as { note?: string }
    expect(none.note).toMatch(/do not guess/i)
  })

  it('a read only loop never looks for new people, because that saves rows', async () => {
    m.loadOwnedCompany.mockResolvedValue({ company: { id: 'c1', name: 'Stripe', domain: null } })
    await call('people', { company_id: 'c1', find_new: true }, ctxFor(world(), { readOnly: true }))
    expect(m.sourceContacts).not.toHaveBeenCalled()
    await call('people', { company_id: 'c1', find_new: true }, ctxFor(world()))
    expect(m.sourceContacts).toHaveBeenCalledTimes(1)
  })

  it('a company that is not the persons is an error with a fix', async () => {
    m.loadOwnedCompany.mockResolvedValue({ error: 'No company found with id "x".' })
    expect(await call('people', { company_id: 'x' }, ctxFor(world()))).toMatchObject({ error: expect.stringContaining('No company'), fix: expect.stringContaining('find_roles') })
  })

  it('search_knowledge joins saved notes and memories', async () => {
    m.doSearchKb.mockResolvedValue({ count: 1, hits: [{ title: 'Stripe notes', url: null, content: 'They like small teams.', rank: 1 }] })
    m.searchMemories.mockResolvedValue([{ id: 'm1', memory: 'Prefers small teams.' }])
    const out = (await call('search_knowledge', { query: 'small teams' }, ctxFor())) as { count: number; notes: unknown[]; memories: { memory: string }[] }
    expect(out.count).toBe(2)
    expect(out.memories[0].memory).toBe('Prefers small teams.')
    expect(m.searchMemories).toHaveBeenCalledWith('u1', 'small teams', { limit: 5 })
  })

  it('a memory search that fails still returns the saved notes', async () => {
    m.doSearchKb.mockResolvedValue({ count: 1, hits: [{ title: 'Stripe notes', url: null, content: 'They like small teams.', rank: 1 }] })
    m.searchMemories.mockRejectedValue(new Error('no embedding key'))
    const out = (await call('search_knowledge', { query: 'small teams' }, ctxFor())) as { count: number; memories: unknown[] }
    expect(out).toMatchObject({ count: 1, memories: [] })
  })
})

describe('remember', () => {
  const said = (text: string) => new HumanMessage(text)

  it('only the persons own words count, ignoring case and spacing', () => {
    const msgs = [said('I only want teams under  50 people.'), new AIMessage('Got it.')]
    expect(quoteIsTheirs('teams under 50 people', msgs)).toBe(true)
    expect(quoteIsTheirs('I Only Want Teams', msgs)).toBe(true)
    expect(quoteIsTheirs('Got it.', msgs)).toBe(false)
    expect(quoteIsTheirs('short', msgs)).toBe(false)
  })

  it('an approval result Cello added is not the persons words', () => {
    const event = new HumanMessage({ content: '<event>The person approved the email.</event>', additional_kwargs: { cello_event: true } })
    expect(quoteIsTheirs('The person approved the email', [event])).toBe(false)
  })

  it('refuses a quote that is not in what the person wrote, so text from a post can never become memory', async () => {
    const out = await call('remember', { fact: 'Wants to relocate to Berlin.', user_quote: 'The candidate wants to relocate to Berlin' }, ctxFor(), { messages: [said('find me roles'), new AIMessage('Here they are'), new AIMessage('Tool result: the candidate wants to relocate to Berlin')] })
    expect(isToolFix(out)).toBe(true)
    expect(m.proposeLearning).not.toHaveBeenCalled()
  })

  it('proposes what the person said as a learning with their quote, kept only when they keep it', async () => {
    m.proposeLearning.mockResolvedValue({ statement: 'Prefers teams under 50 people.' })
    const out = (await call('remember', { fact: 'Prefers teams under 50 people.', user_quote: 'I only want teams under 50 people' }, ctxFor(), { messages: [said('I only want teams under 50 people.')] })) as { saved_in: string[] }
    expect(m.proposeLearning).toHaveBeenCalledWith('u1', 'Prefers teams under 50 people.', 'I only want teams under 50 people', { isDemo: false })
    expect(out.saved_in).toEqual(['what Cello learned'])
  })

  it('over MCP there is no conversation, so it refuses', async () => {
    const out = await call('remember', { fact: 'x y z', user_quote: 'any words here' }, ctxFor(), { channel: 'mcp', messages: [said('any words here')] })
    expect(isToolFix(out)).toBe(true)
    expect(m.proposeLearning).not.toHaveBeenCalled()
  })

  it('a refusal from the preference store is an error with a fix', async () => {
    m.proposeLearning.mockRejectedValue(new Error('A preference this long is not allowed.'))
    const out = await call('remember', { fact: 'Prefers x.', user_quote: 'I prefer x' }, ctxFor(), { messages: [said('I prefer x')] })
    expect(out).toMatchObject({ error: expect.stringContaining('not allowed'), fix: expect.any(String) })
  })
})

describe('my_profile', () => {
  const world = () =>
    makeFakeAdmin({
      profiles: [{ id: 'u1', full_name: 'Dana Lee', resume_text: 'Dana Lee\nSenior engineer at Acme.\n' + 'Built billing. '.repeat(300), preferences: { preferredLocations: ['Seattle'], remotePreference: 'any', targeting: { excludedCompanies: ['badco'] } } }],
      role_reactions: [
        { user_id: 'u1', reaction: 'not_for_me', reason: 'company', job_title: 'Staff Engineer', company_name: 'Globex', created_at: '2026-10-03T00:00:00Z' },
        { user_id: 'u1', reaction: 'interested', reason: null, job_title: 'PM', company_name: 'Acme', created_at: '2026-10-01T00:00:00Z' },
        { user_id: 'u2', reaction: 'interested', reason: null, job_title: 'Not mine', company_name: 'X', created_at: '2026-10-02T00:00:00Z' },
      ],
    })

  it('an overview names each part without the resume text', async () => {
    m.getApplication.mockResolvedValue({ total: 4, byStage: { applied: 3, interview: 1 }, recent: [] })
    const out = (await call('my_profile', {}, ctxFor(world()))) as Record<string, unknown>
    expect(out.name).toBe('Dana Lee')
    expect(out.resume).toMatchObject({ has_resume: true })
    expect(JSON.stringify(out)).not.toContain('Built billing. Built billing.')
    expect(out.dealbreakers).toMatchObject({ excluded_companies: ['badco'] })
    expect(out.history).toMatchObject({ applications: 4 })
  })

  it('each section returns its part, and the resume is cut and says so', async () => {
    const resume = (await call('my_profile', { section: 'resume' }, ctxFor(world()))) as { text: string; truncated?: boolean; characters: number }
    expect(resume.text.length).toBeLessThanOrEqual(2500)
    expect(resume.truncated).toBe(true)
    const prefs = (await call('my_profile', { section: 'preferences' }, ctxFor(world()))) as { preferred_locations: string[]; stated: string[] }
    expect(prefs).toMatchObject({ preferred_locations: ['Seattle'], stated: ['Prefers small teams'] })
    const taste = (await call('my_profile', { section: 'taste' }, ctxFor(world()))) as { reactions: Record<string, unknown>[] }
    expect(taste.reactions).toEqual([
      { reaction: 'not_for_me', reason: 'company', role: 'Staff Engineer', company: 'Globex', date: '2026-10-03' },
      { reaction: 'interested', reason: null, role: 'PM', company: 'Acme', date: '2026-10-01' },
    ])
  })

  it('no resume says how to fix it', async () => {
    const admin = makeFakeAdmin({ profiles: [{ id: 'u1', resume_text: '', preferences: {} }] })
    expect(await call('my_profile', { section: 'resume' }, ctxFor(admin))).toMatchObject({ has_resume: false, note: expect.stringContaining('upload') })
  })
})

describe('create_artifact and update_artifact', () => {
  it('a document goes to the Writer with a key and the brief the person gave', async () => {
    m.runWriter.mockResolvedValue({ status: 'ok', artifact_id: 'a1', version: 1 })
    const out = await call('create_artifact', { type: 'cover_letter', job_id: 'j1', instructions: 'short' }, ctxFor())
    expect(out).toMatchObject({ status: 'ok', artifact_id: 'a1' })
    expect(m.runWriter.mock.calls[0][1]).toEqual({ type: 'cover_letter', job_id: 'j1', contact_id: undefined, instructions: 'short', idempotency_key: 't1:call-1' })
  })

  it('dossier and shortlist cannot be created here', () => {
    const def = toolByName('create_artifact')!
    expect(def.schema.safeParse({ type: 'dossier' }).success).toBe(false)
    expect(def.schema.safeParse({ type: 'shortlist' }).success).toBe(false)
  })

  it('a writer failure is an error with a fix', async () => {
    m.runWriter.mockResolvedValue({ status: 'failed', error: 'There is no resume on file.', fix: 'Ask the person to upload one.' })
    expect(await call('create_artifact', { type: 'resume', job_id: 'j1' }, ctxFor())).toEqual({ error: 'There is no resume on file.', fix: 'Ask the person to upload one.' })
  })

  it('a retry with the same key passes the same key on', async () => {
    m.runWriter.mockResolvedValue({ status: 'ok', artifact_id: 'a1' })
    await call('create_artifact', { type: 'cover_letter', job_id: 'j1', idempotency_key: 'my-key' }, ctxFor())
    expect(m.runWriter.mock.calls[0][1].idempotency_key).toBe('my-key')
  })

  it('update revises a writer artifact and refuses the others with the right next step', async () => {
    const admin = makeFakeAdmin({
      artifacts: [
        { id: 'a1', user_id: 'u1', type: 'cover_letter', title: 'L', current_version: 1, job_id: 'j1' },
        { id: 'a2', user_id: 'u1', type: 'dossier', title: 'D', current_version: 1 },
        { id: 'a3', user_id: 'u2', type: 'cover_letter', title: 'Not mine', current_version: 1 },
      ],
    })
    m.runWriter.mockResolvedValue({ status: 'ok', artifact_id: 'a1', version: 2 })
    expect(await call('update_artifact', { id: 'a1', change: 'make it shorter' }, ctxFor(admin))).toMatchObject({ version: 2 })
    expect(m.runWriter.mock.calls[0][1]).toMatchObject({ type: 'cover_letter', artifact_id: 'a1', instructions: 'make it shorter' })
    expect(await call('update_artifact', { id: 'a2', change: 'shorter' }, ctxFor(admin))).toMatchObject({ fix: expect.stringContaining('research') })
    expect(await call('update_artifact', { id: 'a3', change: 'shorter' }, ctxFor(admin))).toMatchObject({ error: expect.stringContaining('No artifact') })
  })
})

describe('pipeline', () => {
  const world = () =>
    makeFakeAdmin(
      {
        applications: [{ id: 'app1', user_id: 'u1', job_id: 'j1', stage: 'discovered', applied_at: null }, { id: 'app2', user_id: 'u2', job_id: 'j9', stage: 'applied' }],
        interactions: [],
        artifacts: [
          { id: 'a1', user_id: 'u1', type: 'cover_letter', title: 'Letter', current_version: 1 },
          { id: 'a2', user_id: 'u1', type: 'dossier', title: 'Dossier', current_version: 1 },
        ],
        artifact_versions: [
          { artifact_id: 'a1', version: 1, content: { text: 'Dear team' }, content_text: 'Dear team' },
          { artifact_id: 'a2', version: 1, content: {}, content_text: '' },
        ],
      },
      {}
    )

  it('lists, and a missing role is an error with a fix', async () => {
    m.getApplication.mockResolvedValue({ total: 2, byStage: { applied: 2 }, recent: Array.from({ length: 12 }, (_, i) => ({ applicationId: `a${i}` })) })
    const out = (await call('pipeline', { action: 'list', limit: 3 }, ctxFor(world()))) as { recent: unknown[] }
    expect(out.recent).toHaveLength(3)
    m.getApplication.mockResolvedValue({ error: 'No job found with id "x".' })
    expect(await call('pipeline', { action: 'list', job_id: 'x' }, ctxFor(world()))).toMatchObject({ fix: expect.any(String) })
  })

  it('move changes the stage, stamps applied, records it, and does nothing twice', async () => {
    const admin = world()
    const out = await call('pipeline', { action: 'move', application_id: 'app1', stage: 'applied' }, ctxFor(admin))
    expect(out).toMatchObject({ ok: true, stage: 'applied', was: 'discovered' })
    expect(admin.tables.applications[0].stage).toBe('applied')
    expect(admin.tables.applications[0].applied_at).toBeTruthy()
    expect(admin.tables.interactions[0]).toMatchObject({ kind: 'stage_change', title: 'Moved to applied' })
    expect(await call('pipeline', { action: 'move', application_id: 'app1', stage: 'applied' }, ctxFor(admin))).toMatchObject({ note: 'Already in that stage.' })
  })

  it('refuses another persons application and a stage that does not exist', async () => {
    expect(await call('pipeline', { action: 'move', application_id: 'app2', stage: 'offer' }, ctxFor(world()))).toMatchObject({ error: expect.stringContaining('No application') })
    expect(toolByName('pipeline')!.schema.safeParse({ action: 'move', stage: 'hired' }).success).toBe(false)
    expect(await call('pipeline', { action: 'move', application_id: 'app1' }, ctxFor(world()))).toMatchObject({ error: 'move needs a stage.' })
  })

  it('attach puts a saved cover letter on the application and refuses a dossier', async () => {
    const admin = world()
    expect(await call('pipeline', { action: 'attach', application_id: 'app1', artifact_id: 'a1' }, ctxFor(admin))).toMatchObject({ ok: true, attached: 'cover_letter' })
    expect(admin.tables.applications[0].cover_letter).toBe('Dear team')
    expect(await call('pipeline', { action: 'attach', application_id: 'app1', artifact_id: 'a2' }, ctxFor(admin))).toMatchObject({ error: expect.stringContaining('cannot be attached') })
  })
})

describe('request_approval', () => {
  const queued = (status = 'pending') => ({ ok: true, created: true, approval: { id: 'ap1', status, action: 'send_email' } })

  it('queues and returns waiting at once, never sends', async () => {
    m.queueApproval.mockResolvedValue(queued())
    const out = await call('request_approval', { action: 'send_email', artifact_id: 'a1' }, ctxFor())
    expect(out).toEqual({ status: 'waiting', approval_id: 'ap1', message: 'Waiting for your approval in Needs you.' })
    expect(m.queueApproval.mock.calls[0][1]).toMatchObject({ action: 'send_email', artifactId: 'a1', idempotencyKey: 't1:call-1' })
    expect(m.autoApprove).not.toHaveBeenCalled()
  })

  it('a repeat says it was already queued', async () => {
    m.queueApproval.mockResolvedValue({ ...queued(), created: false })
    expect(await call('request_approval', { action: 'send_email', artifact_id: 'a1' }, ctxFor())).toMatchObject({ status: 'waiting', note: 'This was already queued.' })
  })

  it('an error from queueing is the tool error', async () => {
    m.queueApproval.mockResolvedValue({ ok: false, error: 'Dana has no email address.', fix: 'Ask for one.' })
    expect(await call('request_approval', { action: 'send_email', artifact_id: 'a1' }, ctxFor())).toEqual({ error: 'Dana has no email address.', fix: 'Ask for one.' })
  })

  it('in a chat conversation nothing is approved by rule, whatever the autonomy says', async () => {
    m.queueApproval.mockResolvedValue(queued())
    await call('request_approval', { action: 'send_email', artifact_id: 'a1' }, ctxFor(makeFakeAdmin(), { autonomy: 'act', rules: { allow_send_email: true } }))
    expect(m.autoApprove).not.toHaveBeenCalled()
  })

  it('a scheduled task set to act within its rules approves what the rules allow, through the same code', async () => {
    m.queueApproval.mockResolvedValue(queued())
    m.autoApprove.mockResolvedValue({ status: 200, approval: { status: 'done' }, copy: 'Sent from dana@example.com at 8:00. Saved.' })
    const out = await call('request_approval', { action: 'send_email', artifact_id: 'a1' }, ctxFor(makeFakeAdmin(), { scheduledTaskId: 'task-1', autonomy: 'act', rules: { allow_send_email: true } }))
    expect(out).toMatchObject({ status: 'approved_by_rule' })
    expect(m.autoApprove.mock.calls[0][0]).toEqual({ autonomy: 'act', rules: { allow_send_email: true } })
  })

  it('a scheduled task whose rules do not allow it leaves it waiting', async () => {
    m.queueApproval.mockResolvedValue(queued())
    m.autoApprove.mockResolvedValue(null)
    const out = await call('request_approval', { action: 'send_email', artifact_id: 'a1' }, ctxFor(makeFakeAdmin(), { scheduledTaskId: 'task-1', autonomy: 'draft' }))
    expect(out).toMatchObject({ status: 'waiting' })
  })
})

describe('schedule_task', () => {
  const world = () => makeFakeAdmin({ copilot_conversations: [] }, { scheduled_tasks: { defaults: () => ({ status: 'active', rules: {}, poked_at: null }) } })
  const base = { name: 'Find new roles', instruction: 'Find new roles that fit me.', every: 'weekday', at: '08:00', timezone: 'America/Los_Angeles' }

  it('creates a task and says when it runs next', async () => {
    const admin = world()
    const out = (await call('schedule_task', base, ctxFor(admin))) as Record<string, unknown>
    expect(out).toMatchObject({ ok: true, name: 'Find new roles', schedule: 'Every weekday at 8:00', autonomy: 'ask' })
    expect(out.next_run_at).toBeTruthy()
    expect(admin.tables.scheduled_tasks).toHaveLength(1)
  })

  it('asking for act within my rules saves draft and says the person must turn it on', async () => {
    const admin = world()
    const out = (await call('schedule_task', { ...base, autonomy: 'act' }, ctxFor(admin))) as Record<string, unknown>
    expect(out).toMatchObject({ autonomy: 'draft', needs_person: expect.stringContaining('turned on by the person') })
    expect(admin.tables.scheduled_tasks[0].autonomy).toBe('draft')
    expect(admin.tables.scheduled_tasks[0].rules).toEqual({})
  })

  it('never raises the autonomy of an existing task', async () => {
    const admin = world()
    const created = (await call('schedule_task', { ...base, autonomy: 'ask' }, ctxFor(admin))) as { task_id: string }
    const out = await call('schedule_task', { task_id: created.task_id, autonomy: 'act' }, ctxFor(admin))
    expect(out).toMatchObject({ autonomy: 'ask', needs_person: expect.any(String) })
  })

  it('changes and pauses a task', async () => {
    const admin = world()
    const created = (await call('schedule_task', base, ctxFor(admin))) as { task_id: string }
    expect(await call('schedule_task', { task_id: created.task_id, every: 'day', at: '06:30', timezone: 'UTC' }, ctxFor(admin))).toMatchObject({ schedule: 'Every day at 6:30' })
    expect(await call('schedule_task', { task_id: created.task_id, status: 'paused' }, ctxFor(admin))).toMatchObject({ status: 'paused', next_run_at: null })
  })

  it('a running scheduled task cannot create or change tasks, so text it reads cannot set up its own repeat', async () => {
    const admin = world()
    const out = await call('schedule_task', base, ctxFor(admin, { scheduledTaskId: 'task-1' }))
    expect(isToolFix(out)).toBe(true)
    expect(admin.tables.scheduled_tasks ?? []).toHaveLength(0)
  })

  it('a demo cannot schedule anything, so nothing repeats after the demo ends', async () => {
    const admin = world()
    const out = await call('schedule_task', base, ctxFor(admin, { isDemo: true }))
    expect(out).toMatchObject({ error: 'Demo accounts cannot schedule tasks.' })
    expect(admin.tables.scheduled_tasks ?? []).toHaveLength(0)
  })

  it('a bad time zone or a missing field is an error the model can act on', async () => {
    expect(await call('schedule_task', { ...base, timezone: 'Mars/Olympus' }, ctxFor(world()))).toMatchObject({ error: expect.stringContaining('not a time zone'), fix: expect.stringContaining('IANA') })
    expect(await call('schedule_task', { name: 'x' }, ctxFor(world()))).toMatchObject({ fix: expect.stringContaining('time zone') })
    expect(await call('schedule_task', { task_id: 'nope', name: 'x' }, ctxFor(world()))).toMatchObject({ error: expect.stringContaining('No scheduled task') })
  })
})

describe('as LangChain tools', () => {
  it('a thrown error becomes an error message the model can act on', async () => {
    m.roleView.mockRejectedValue(new Error('database is down'))
    const tool = toAgentTools(ctxFor()).find((t) => t.name === 'get_role')!
    const out = await tool.invoke({ id: 'x', response_format: 'concise', limit: 10 }, { toolCall: { id: 'c1', name: 'get_role', args: {} } } as never)
    expect(String((out as { content?: string }).content ?? out)).toContain('get_role failed: database is down')
  })

  it('the budget cap travels up so the fallback and the message work', async () => {
    m.roleView.mockRejectedValue(new BudgetCapError(10, 10))
    const tool = toAgentTools(ctxFor()).find((t) => t.name === 'get_role')!
    await expect(tool.invoke({ id: 'x', response_format: 'concise', limit: 10 }, { toolCall: { id: 'c1', name: 'get_role', args: {} } } as never)).rejects.toThrow(/budget|cap/i)
  })
})
