import { describe, expect, it } from 'vitest'
import type { LlmResult, LlmRunOptions } from '@/lib/harness/types'
import { NO_CONSTRAINTS } from './constraints'
import { buildShortlist, retrievePool, roleText, type Embedder } from './pipeline'
import { MemoryStore } from './store'
import { NO_STATED } from './want-judge'
import type { ReactionRecord, RoleFacts } from './types'

const RESUME = 'Jane Doe\nBackend engineer, Brightpay, 2018-2024: built payment services in Go\nSkills: Go, Java, PostgreSQL'

function desc(topic: string): string {
  return `We build ${topic} products for our customers every day and care about reliability. What you bring: 3+ years of backend engineering. Strong Go or Java. Nice to have: Kubernetes. We offer equity and a learning budget for everyone on the team.`
}

function role(id: string, topic: string, extra: Partial<RoleFacts> = {}): RoleFacts {
  return { id, title: `Backend Engineer, ${topic}`, company: `Co${id}`, location: 'Seattle, WA', description: desc(topic), ...extra }
}

/** Bag of words hashed into 32 buckets: enough for "payments roles resemble payments roles". */
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

interface Calls {
  names: string[]
  systems: string[]
}

/** A fake model that likes payments roles and answers requirement and chance checks consistently. */
function fakeLlm(calls: Calls) {
  return async (opts: LlmRunOptions): Promise<LlmResult> => {
    calls.names.push(opts.name ?? '')
    calls.systems.push(opts.system ?? '')
    const prompt = opts.prompt ?? ''
    let content = '{}'
    if (opts.name === 'judge-role-want') {
      const blocks = [...prompt.matchAll(/\[\[ROLE (a\d+) [^\]]*\]\]\n([^\[]*)/g)]
      content = JSON.stringify({
        roles: blocks.map((m) => {
          const payments = /payments/i.test(m[2])
          return { id: m[1], p: payments ? 0.85 : 0.2, stated_p: 0.5, reason: payments ? 'Payments backend like the roles you liked.' : 'Not the kind of work you went for.' }
        }),
      })
    } else if (opts.name === 'extract-role-requirements') {
      const blocks = [...prompt.matchAll(/\[\[POSTING (p\d+) /g)]
      content = JSON.stringify({
        postings: blocks.map((m) => ({
          id: m[1],
          enough_detail: true,
          requirements: [
            { text: '3+ years backend', kind: 'experience', must_have: true, quote: '3+ years of backend engineering' },
            { text: 'Strong Go or Java', kind: 'skill', must_have: true, quote: 'Strong Go or Java' },
            { text: 'Kubernetes', kind: 'skill', must_have: false, quote: 'Nice to have: Kubernetes' },
          ],
        })),
      })
    } else if (opts.name === 'check-role-requirements') {
      const ids = [...prompt.matchAll(/^(j\d+\.r\d+) /gm)].map((m) => m[1])
      content = JSON.stringify({
        checks: ids.map((id) =>
          id.endsWith('r3')
            ? { id, status: 'not_met', line: null, quote: null }
            : { id, status: 'met', line: 2, quote: 'built payment services in Go' }
        ),
      })
    }
    return { content, tokensUsed: 1, promptTokens: 1, completionTokens: 1, model: 'fake' }
  }
}

function req(store: MemoryStore, candidates: RoleFacts[], over: Partial<Parameters<typeof buildShortlist>[1]> = {}) {
  const calls: Calls = { names: [], systems: [] }
  const run = () =>
    buildShortlist(
      { llm: fakeLlm(calls), embed: embedder, store, rng: () => 0.5 },
      { userId: 'u', resumeText: RESUME, stated: { ...NO_STATED, titles: ['Backend Engineer'] }, constraints: NO_CONSTRAINTS, candidates, forDate: '2026-10-06', ...over }
    )
  return { calls, run }
}

describe('buildShortlist', () => {
  const candidates = [
    ...['a', 'b', 'c', 'd'].map((id) => role(id, 'payments')),
    ...['e', 'f', 'g', 'h'].map((id) => role(id, 'advertising')),
  ]

  it('shortlists roles with one labelled exploration pick, an explanation for each, and persists them', async () => {
    const store = new MemoryStore()
    const { run } = req(store, candidates)
    const out = await run()
    expect(out.picks).toHaveLength(6)
    expect(out.picks.filter((p) => p.kind === 'explore')).toHaveLength(1)
    expect(out.picks.filter((p) => p.kind === 'top').slice(0, 4).map((p) => p.jobId).sort()).toEqual(['a', 'b', 'c', 'd'])
    for (const p of out.picks) expect(p.explanation).toMatch(/\.$/)
    expect(store.shortlists.get('2026-10-06')).toEqual(out.picks)
    expect(store.assessmentRows.size).toBe(8)
  })

  it('removes roles that break a stated constraint and stores the reason instead of scoring them', async () => {
    const store = new MemoryStore()
    const { run, calls } = req(store, [...candidates, role('x', 'payments', { company: 'Coinbase' })], {
      constraints: { ...NO_CONSTRAINTS, excludedCompanies: ['coinbase'] },
    })
    const out = await run()
    expect(out.blocked).toEqual([{ jobId: 'x', reasons: [{ kind: 'company', text: 'You ruled out Coinbase.' }] }])
    expect(out.picks.map((p) => p.jobId)).not.toContain('x')
    expect(store.assessmentRows.get('x')).toMatchObject({ blocked: true, want: null })
    expect(calls.names.filter((n) => n === 'judge-role-want').length).toBeGreaterThan(0)
  })

  it('says cannot assess for a posting with no description and never calls the model for its requirements', async () => {
    const store = new MemoryStore()
    const { run } = req(store, [role('thin', 'payments', { description: null }), role('ok', 'payments')])
    const out = await run()
    expect(store.assessmentRows.get('thin')!.chance?.chance).toBe('cannot_assess')
    expect(store.assessmentRows.get('ok')!.chance?.chance).toBe('strong')
    expect(out.picks.find((p) => p.jobId === 'thin')?.explanation).toContain('too thin')
  })

  it('learns: after reactions the judge sees the decisions and the similarity vote favours what was liked', async () => {
    const store = new MemoryStore()
    const reactions: ReactionRecord[] = [
      ...['p1', 'p2', 'p3'].map((id, i) => ({
        id, jobId: `old-${id}`, reaction: 'interested' as const, reason: null, title: 'Backend Engineer, payments', company: 'X', location: null,
        text: roleText(role(id, 'payments')), embedding: null, embeddingModel: null, predicted: null, at: `2026-10-0${i + 1}T00:00:00Z`,
      })),
      ...['n1', 'n2', 'n3'].map((id, i) => ({
        id, jobId: `old-${id}`, reaction: 'not_for_me' as const, reason: 'domain' as const, title: 'Backend Engineer, advertising', company: 'Y', location: null,
        text: roleText(role(id, 'advertising')), embedding: null, embeddingModel: null, predicted: null, at: `2026-10-0${i + 4}T00:00:00Z`,
      })),
    ]
    store.reactionRows = reactions
    const { run, calls } = req(store, candidates)
    const out = await run()
    expect(calls.systems.find((s) => s.includes('[not for me, domain]'))).toBeTruthy()
    expect(store.reactionRows.every((r) => r.embedding && r.embeddingModel === 'test/embed')).toBe(true)
    const byId = new Map(out.assessed.map((a) => [a.jobId, a.want!.components.embedding]))
    expect(byId.get('a')!).toBeGreaterThan(byId.get('e')!)
    expect(out.taste.nReactions).toBe(6)
  })

  it('records what it predicted for every judged role, so the blend can be fitted later', async () => {
    const store = new MemoryStore()
    const { run } = req(store, candidates)
    const out = await run()
    for (const a of out.assessed) {
      expect(a.want!.components.judge).not.toBeNull()
      expect(a.want!.p).toBeGreaterThan(0)
      expect(a.want!.p).toBeLessThan(1)
    }
  })

  it('still works with no embedding provider and says so', async () => {
    const store = new MemoryStore()
    const calls: Calls = { names: [], systems: [] }
    const out = await buildShortlist(
      { llm: fakeLlm(calls), embed: null, store, rng: () => 0.5 },
      { userId: 'u', resumeText: RESUME, stated: NO_STATED, constraints: NO_CONSTRAINTS, candidates, forDate: '2026-10-06' }
    )
    expect(out.picks.length).toBeGreaterThan(0)
    expect(out.notes.join(' ')).toMatch(/No embedding provider/)
  })

  it('returns an honest empty list when every role is ruled out', async () => {
    const store = new MemoryStore()
    const { run } = req(store, candidates, { constraints: { ...NO_CONSTRAINTS, onlyCountries: ['DE'] } })
    const out = await run()
    expect(out.picks).toEqual([])
    expect(out.blocked).toHaveLength(8)
  })
})

describe('retrievePool', () => {
  const roles = Array.from({ length: 30 }, (_, i) => role(`r${i}`, i % 2 ? 'payments' : 'advertising', { title: i < 3 ? 'Staff Designer' : `Backend Engineer ${i}` }))

  it('returns everything when the pool is larger than the candidates', () => {
    expect(retrievePool(roles.slice(0, 5), new Map(), NO_STATED, 10, () => 0.5)).toHaveLength(5)
  })

  it('mixes taste, stated titles and random roles up to the size, without repeats', () => {
    const pEmb = new Map(roles.map((r, i) => [r.id, i / 30]))
    const pool = retrievePool(roles, pEmb, { ...NO_STATED, titles: ['Staff Designer'] }, 10, () => 0.3)
    expect(pool).toHaveLength(10)
    expect(new Set(pool.map((r) => r.id)).size).toBe(10)
    expect(pool.map((r) => r.id)).toContain('r29')
    expect(pool.map((r) => r.id)).toContain('r0')
  })
})
