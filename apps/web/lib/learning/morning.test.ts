// The morning order. A learning the person turned off changes the order of their roles, and
// their application history alone (no tap on any role) changes it too. The judge here is
// neutral on purpose, so any difference in order comes from taste and nothing else.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, LlmResult, LlmRunOptions } from '@/lib/harness/types'
import { NO_CONSTRAINTS } from '@/lib/scoring/constraints'
import { assessRoles, roleText, type Embedder } from '@/lib/scoring/pipeline'
import { MemoryStore } from '@/lib/scoring/store'
import type { ReactionRecord, RoleFacts } from '@/lib/scoring/types'
import { NO_STATED } from '@/lib/scoring/want-judge'
import { FakeMemoryStore } from './fake-store'
import { runLearner } from './learner'
import { setLearningStatus, allLearnings } from './store'

const memory = new FakeMemoryStore()
vi.mock('@/lib/memory/mem0-store', () => ({ getMemoryStore: () => memory }))

const { loadScoringInputs } = await import('@/lib/scoring/inputs')

const USER = 'u1'
const RESUME = 'Jane Doe\nBackend engineer: built payment services in Go'

const role = (id: string, topic: string): RoleFacts => ({
  id,
  title: `Backend Engineer, ${topic}`,
  company: 'Acme',
  location: 'Seattle, WA',
  description: `We build ${topic} products for our customers every day and care about reliability.`,
})

/** Bag of words hashed into 32 buckets: "advertising roles resemble advertising roles". */
const embedder: Embedder = {
  model: 'test/embed',
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(32).fill(0)
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 32
        v[h] += 1
      }
      return v
    })
  },
}

/** A judge with no opinion: every role is 0.5. */
const neutralJudge = async (opts: LlmRunOptions): Promise<LlmResult> => {
  const blocks = [...(opts.prompt ?? '').matchAll(/\[\[ROLE (a\d+) /g)]
  const content = opts.name === 'judge-role-want' ? JSON.stringify({ roles: blocks.map((m) => ({ id: m[1], p: 0.5, reason: 'No view either way.' })) }) : '{}'
  return { content, tokensUsed: 1, promptTokens: 1, completionTokens: 1, model: 'fake' }
}

const candidates = [...['a', 'b', 'c', 'd'].map((id) => role(id, 'payments')), ...['e', 'f', 'g', 'h'].map((id) => role(id, 'advertising'))]

/** Four past applications, three to advertising roles and one to a payments role, written as the applied reactions the application trigger makes. */
function history(): ReactionRecord[] {
  return ['x1', 'x2', 'x3', 'x4'].map((id, i) => {
    const r = role(id, id === 'x4' ? 'payments' : 'advertising')
    return { id, jobId: `old-${id}`, reaction: 'applied' as const, reason: null, title: r.title, company: r.company, location: null, text: roleText(r), embedding: null, embeddingModel: null, predicted: null, at: `2026-09-0${i + 1}T00:00:00Z` }
  })
}

async function order(reactions: ReactionRecord[], taste?: boolean): Promise<{ ids: string[]; p: number[]; store: MemoryStore }> {
  const store = new MemoryStore()
  store.reactionRows = reactions
  const out = await assessRoles(
    { llm: neutralJudge, embed: embedder, store, rng: () => 0.5 },
    { userId: USER, resumeText: RESUME, stated: NO_STATED, constraints: NO_CONSTRAINTS, candidates, chanceFor: 0, taste }
  )
  const ranked = [...out.assessed].sort((x, y) => y.want!.p - x.want!.p)
  return { ids: ranked.map((a) => a.jobId), p: ranked.map((a) => a.want!.p), store }
}

describe('what orders the morning', () => {
  it('application history alone, with no reaction to any role, puts the kind of role they applied to most first', async () => {
    const { ids } = await order(history())
    expect(new Set(ids.slice(0, 4))).toEqual(new Set(['e', 'f', 'g', 'h']))
  })

  it('with no history and a neutral judge nothing is ahead of anything', async () => {
    const { p } = await order([])
    expect(new Set(p.map((x) => x.toFixed(6))).size).toBe(1)
  })

  it('with taste turned off the same history orders nothing: the order is the code order', async () => {
    const { p, store } = await order(history(), false)
    expect(new Set(p.map((x) => x.toFixed(6))).size).toBe(1)
    // The cached fit is left as it was, and no vector was made for the history.
    expect(store.tasteRow).toBeNull()
  })

  it('turning taste:blend off changes the order the next morning, and turning it on again brings it back', async () => {
    const reactions = history()
    const learner = { admin: { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: reactions.map((r, i) => ({ id: r.id, reaction: r.reaction, reason: null, surface: 'applications', note: null, i })), error: null }) }) }) }) } as unknown as AdminClient, store: memory }
    await runLearner(USER, learner)
    const blend = (await allLearnings(USER, memory)).find((l) => l.key === 'taste:blend')!
    expect(blend.statement).toBe('Your 4 past applications and 0 reactions order your roles')

    const morning = async () => order(reactions, (await loadScoringInputs(chainAdmin(), USER)).taste)
    const before = await morning()
    await setLearningStatus(USER, blend.id, 'off', memory)
    const off = await morning()
    await setLearningStatus(USER, blend.id, 'active', memory)
    const on = await morning()

    expect(new Set(before.ids.slice(0, 4))).toEqual(new Set(['e', 'f', 'g', 'h']))
    expect(new Set(off.p.map((x) => x.toFixed(6))).size).toBe(1)
    expect(on.ids).toEqual(before.ids)
  })
})

/** Any query chain, answering one fixed result per table. */
function chainAdmin(): AdminClient {
  const results: Record<string, unknown> = { profiles: { data: { resume_text: RESUME, preferences: {} } }, companies: { data: [] }, role_reactions: { count: 4 } }
  const chain = (table: string): unknown => {
    const proxy: unknown = new Proxy(
      {},
      { get: (_t, prop) => (prop === 'then' ? (resolve: (v: unknown) => unknown) => resolve(results[table]) : () => proxy) }
    )
    return proxy
  }
  return { from: (t: string) => chain(t) } as unknown as AdminClient
}

describe('what the morning reads from mem0', () => {
  beforeEach(() => {
    memory.rows = []
    memory.down = false
  })

  it('reads once, and passes taste on when nothing is turned off', async () => {
    const inputs = await loadScoringInputs(chainAdmin(), USER)
    expect(inputs.taste).toBe(true)
    expect(inputs.learningNote).toBeNull()
  })

  it('with mem0 unreachable the order is the code order and the page gets the one line', async () => {
    memory.down = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inputs = await loadScoringInputs(chainAdmin(), USER)
    expect(inputs.taste).toBe(false)
    expect(inputs.learningNote).toBe('Cello could not read what it learned. Roles are in their usual order.')
    expect(inputs.stated.notes).toEqual([])
  })

  it('only wants the person kept reach the judge as their stated notes', async () => {
    const add = (key: string, status: string, origin: string, text: string) =>
      memory.add(USER, { fact: text, scope: 'learning', refs: { key, kind: 'preference', effect: 'rank.want', params: {}, status, origin, evidence: [], n: 0, updated_at: 'now' }, isDemo: false })
    await add('a', 'active', 'person', 'Prefers small teams')
    await add('b', 'proposed', 'model', 'A read nobody kept')
    await add('c', 'active', 'code', 'A count, not a want')
    const inputs = await loadScoringInputs(chainAdmin(), USER)
    expect(inputs.stated.notes).toEqual(['Prefers small teams'])
  })
})
