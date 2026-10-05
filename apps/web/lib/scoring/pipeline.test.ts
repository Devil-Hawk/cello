import { describe, expect, it } from 'vitest'
import type { LlmResult, LlmRunOptions } from '@/lib/harness/types'
import { NO_CONSTRAINTS } from './constraints'
import { assessRoles, buildShortlist, retrievePool, roleText, type Embedder } from './pipeline'
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
    // A judge call that is told there are no decisions is the stated-only read.
    calls.names.push(opts.name === 'judge-role-want' && (opts.system ?? '').includes('(no decisions yet)') ? 'judge-stated' : (opts.name ?? ''))
    calls.systems.push(opts.system ?? '')
    const prompt = opts.prompt ?? ''
    let content = '{}'
    if (opts.name === 'judge-role-want') {
      const blocks = [...prompt.matchAll(/\[\[ROLE (a\d+) [^\]]*\]\]\n([^\[]*)/g)]
      content = JSON.stringify({
        roles: blocks.map((m) => {
          const payments = /payments/i.test(m[2])
          return { id: m[1], p: payments ? 0.85 : 0.2, reason: payments ? 'Payments backend like the roles you liked.' : 'Not the kind of work you went for.' }
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

function req(store: MemoryStore, candidates: RoleFacts[], over: Partial<Parameters<typeof buildShortlist>[1]> = {}, calls: Calls = { names: [], systems: [] }) {
  const base = { userId: 'u', resumeText: RESUME, stated: { ...NO_STATED, titles: ['Backend Engineer'] }, constraints: NO_CONSTRAINTS, candidates, forDate: '2026-10-06', ...over }
  const deps = { llm: fakeLlm(calls), embed: embedder, store, rng: () => 0.5 }
  return { calls, run: () => buildShortlist(deps, base), assess: () => assessRoles(deps, base) }
}

function reactionsFor(n: number): ReactionRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const pay = i % 2 === 0
    const r = role(`h${i}`, pay ? 'payments' : 'advertising')
    return {
      id: `h${i}`, jobId: `old-h${i}`, reaction: pay ? ('interested' as const) : ('not_for_me' as const), reason: pay ? null : ('domain' as const),
      title: r.title, company: r.company, location: null, text: roleText(r), embedding: null, embeddingModel: null, predicted: null, at: `2026-09-${String(i + 10)}T00:00:00Z`,
    }
  })
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
    expect(calls.names.filter((n) => n.startsWith('judge-')).length).toBeGreaterThan(0)
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

describe('assessRoles', () => {
  const candidates = [...['a', 'b', 'c', 'd'].map((id) => role(id, 'payments')), ...['e', 'f', 'g', 'h'].map((id) => role(id, 'advertising'))]
  const count = (calls: Calls, name: string) => calls.names.filter((n) => n === name).length

  it('with no reactions makes one judge pass: the stated read is the same call', async () => {
    const store = new MemoryStore()
    const { assess, calls } = req(store, candidates)
    const out = await assess()
    // With no decisions to show, the one call is the stated-only read.
    expect(count(calls, 'judge-role-want') + count(calls, 'judge-stated')).toBe(1)
    expect(out.taste.nReactions).toBe(0)
    for (const a of out.assessed) expect(a.want!.components.stated).toBe(a.want!.components.judge)
  })

  it('with reactions makes two passes: one that sees the decisions and a stated-only one that does not', async () => {
    const store = new MemoryStore()
    store.reactionRows = reactionsFor(3)
    const { assess, calls } = req(store, candidates)
    const out = await assess()
    expect(count(calls, 'judge-role-want')).toBe(1)
    expect(count(calls, 'judge-stated')).toBe(1)
    const withDecisions = calls.systems.find((s) => s.includes('[not for me, domain]'))
    expect(withDecisions).toBeTruthy()
    expect(withDecisions).not.toContain('(no decisions yet)')
    expect(out.assessed[0].want!.components.stated).not.toBeNull()
  })

  it('keeps the stated read per role, so a second pass asks only about new roles', async () => {
    const store = new MemoryStore()
    store.reactionRows = reactionsFor(3)
    await req(store, candidates).assess()
    const second = req(store, [...candidates, role('z', 'payments')])
    await second.assess()
    expect(count(second.calls, 'judge-stated')).toBe(1)
    const statedCall = second.calls.systems.find((s) => s.includes('(no decisions yet)'))
    expect(statedCall).toBeTruthy()
  })

  it('keeps a settled chance for the same resume and checks it again for a different one', async () => {
    const store = new MemoryStore()
    const first = req(store, candidates)
    await first.assess()
    expect(count(first.calls, 'check-role-requirements')).toBeGreaterThan(0)
    const same = req(store, candidates)
    await same.assess()
    expect(count(same.calls, 'check-role-requirements')).toBe(0)
    const other = req(store, candidates, { resumeText: RESUME + '\nKubernetes operator work' })
    await other.assess()
    expect(count(other.calls, 'check-role-requirements')).toBeGreaterThan(0)
  })

  it('never stores a vector for a posting, only for reactions', async () => {
    const store = new MemoryStore()
    store.reactionRows = reactionsFor(2)
    await req(store, candidates).assess()
    expect(JSON.stringify([...store.assessmentRows.values()])).not.toMatch(/embedding":\[/)
    expect(Object.keys(store)).not.toContain('embeddingRows')
    expect(store.reactionRows.every((r) => Array.isArray(r.embedding) && r.embedding.length === 32)).toBe(true)
  })

  it('writes an assessment for a blocked role with its reasons and no want or chance', async () => {
    const store = new MemoryStore()
    const { assess } = req(store, [...candidates, role('x', 'payments', { company: 'Coinbase' })], { constraints: { ...NO_CONSTRAINTS, excludedCompanies: ['coinbase'] } })
    const out = await assess()
    expect(out.blocked.map((b) => b.jobId)).toEqual(['x'])
    expect(store.assessmentRows.get('x')).toMatchObject({ blocked: true, blockedReasons: [{ kind: 'company' }], want: null, chance: null })
  })

  it('can skip the chance check', async () => {
    const store = new MemoryStore()
    const { assess, calls } = req(store, candidates, { chanceFor: 0 })
    const out = await assess()
    expect(count(calls, 'extract-role-requirements') + count(calls, 'check-role-requirements')).toBe(0)
    expect(out.rankables).toEqual([])
    expect(out.assessed.length).toBe(8)
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
