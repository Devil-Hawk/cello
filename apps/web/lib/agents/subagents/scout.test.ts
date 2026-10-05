import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'

const mocks = vi.hoisted(() => ({ sourceRoles: vi.fn(), shortlistFor: vi.fn() }))
vi.mock('../sources', () => ({ sourceRoles: mocks.sourceRoles }))
vi.mock('../scoring-port', async (orig) => ({ ...(await orig<typeof import('../scoring-port')>()), shortlistFor: mocks.shortlistFor }))

import type { AgentContext } from '../context'
import { buildScoutGraph, runScout, toScoutPick, type ScoutDeps } from './scout'
import { makeFakeAdmin, type FakeAdmin } from '../testing/fake-admin'
import { getArtifact } from '../artifacts'

const pick = (id: string, over = {}) => ({
  jobId: id,
  title: `Role ${id}`,
  company: `Co ${id}`,
  companyId: `c-${id}`,
  location: 'Remote',
  postedAt: null,
  url: null,
  chance: 'strong' as const,
  reason: 'You built billing at Acme.',
  gaps: [],
  exploration: false,
  ...over,
})

function setup() {
  const admin: FakeAdmin = makeFakeAdmin({}, { artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, updated_at: new Date().toISOString() }) } })
  const ctx: AgentContext = {
    admin,
    userId: 'u1',
    userEmail: 'dana@example.com',
    apiKeys: { openrouter: 'k', userId: 'u1' },
    isDemo: false,
    threadId: 't1',
    conversationId: 'conv1',
    autonomy: 'ask',
    traceId: 'trace-1',
    deadlineAt: Date.now() + 60_000,
  }
  const deps: ScoutDeps = { ctx }
  return { admin, deps }
}

const sourced = (over = {}) => ({
  jobIds: ['j1'],
  found: 30,
  inserted: 12,
  perSource: {},
  counts: { ok: 6, partial: 0, failed: 0 },
  notes: ['Searched the job sources: 30 found, 12 fit, 12 new to you'],
  ...over,
})

beforeEach(() => {
  mocks.sourceRoles.mockReset().mockResolvedValue(sourced())
  mocks.shortlistFor.mockReset().mockResolvedValue({ picks: [pick('j1'), pick('j2', { exploration: true, chance: 'possible' })], pool: 9, assessedNow: 1 })
})

describe('Scout', () => {
  it('sources, ranks and saves a shortlist, and returns picks with a reason each', async () => {
    const { deps, admin } = setup()
    const result = await runScout(deps, { query: 'product manager', limit: 5 })
    expect(result.status).toBe('ok')
    expect(result.picks).toEqual([toScoutPick(pick('j1')), toScoutPick(pick('j2', { exploration: true, chance: 'possible' }))])
    expect(result.sourced).toMatchObject({ found: 30, inserted: 12 })
    expect(mocks.shortlistFor.mock.calls[0][0]).toMatchObject({ query: 'product manager', limit: 5, assessMissing: 6 })
    const saved = await getArtifact(admin, 'u1', result.artifact_id!)
    expect(saved?.artifact.type).toBe('shortlist')
    expect(saved?.version.content_text).toContain('Role j1 at Co j1 [strong]: You built billing at Acme.')
    expect(saved?.version.content_text).toContain('to learn from')
  })

  it('reads what is tracked without sourcing when fresh is false, and assesses nothing', async () => {
    const { deps } = setup()
    await runScout(deps, { fresh: false })
    expect(mocks.sourceRoles).not.toHaveBeenCalled()
    expect(mocks.shortlistFor.mock.calls[0][0].assessMissing).toBe(0)
  })

  it('a source failure makes the result partial and says so', async () => {
    mocks.sourceRoles.mockResolvedValue(sourced({ counts: { ok: 4, partial: 1, failed: 1 } }))
    const { deps } = setup()
    const result = await runScout(deps, { query: 'pm' })
    expect(result.status).toBe('partial')
    expect(result.note).toMatch(/did not finish/)
  })

  it('when sourcing itself throws the Scout still ranks what is already tracked', async () => {
    mocks.sourceRoles.mockRejectedValue(new Error('network down'))
    const { deps } = setup()
    const result = await runScout(deps, { query: 'pm' })
    expect(result.status).toBe('ok')
    expect(result.picks).toHaveLength(2)
    expect(result.sourced).toBeUndefined()
  })

  it('an empty result says what to try instead of saving an empty list', async () => {
    mocks.shortlistFor.mockResolvedValue({ picks: [], pool: 0, assessedNow: 0 })
    const { deps, admin } = setup()
    const result = await runScout(deps, { query: 'astronaut' })
    expect(result.picks).toEqual([])
    expect(result.note).toMatch(/broader/)
    expect(admin.tables.artifacts ?? []).toHaveLength(0)
  })

  it('a roles not assessed because of a missing key makes it partial', async () => {
    mocks.shortlistFor.mockResolvedValue({ picks: [pick('j1', { chance: null, reason: 'Not assessed yet.' })], pool: 1, assessedNow: 0, skippedReason: 'no-llm-key' })
    const { deps } = setup()
    const result = await runScout(deps, { query: 'pm' })
    expect(result.status).toBe('partial')
    expect(result.picks?.[0]).toMatchObject({ chance: null, reason: 'Not assessed yet.' })
  })

  it('writes branch rows under its own task when sourcing', async () => {
    const { deps, admin } = setup()
    await runScout(deps, { query: 'pm' })
    const rows = admin.tables.agent_tasks
    expect(rows.some((r) => r.agent === 'scout' && r.title.toString().startsWith('Searching'))).toBe(true)
  })

  it('reached through the task tool, a text brief is parsed; a bad limit is refused with the shape to use', async () => {
    const { deps } = setup()
    const graph = buildScoutGraph(deps)
    const ok = await graph.invoke({ messages: [new HumanMessage('{"query":"pm","limit":3}')] })
    expect(JSON.parse(String(ok.messages.at(-1)?.content)).status).toBe('ok')
    expect(mocks.shortlistFor.mock.calls.at(-1)?.[0].limit).toBe(3)
    const bad = await graph.invoke({ messages: [new HumanMessage('{"limit":500}')] })
    expect(JSON.parse(String(bad.messages.at(-1)?.content)).status).toBe('failed')
  })
})
