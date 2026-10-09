import { describe, expect, it } from 'vitest'
import { fakeDb } from '../../companies/fake-db'
import type { RoutineContext, RoutineRow } from '../routines'
import { KALIL_PROVIDERS, parseKalil, seedWith, ycRows, type SeedDeps } from './directory-seed'

const NOW = Date.parse('2026-10-06T04:00:00Z')

const addressed: Record<string, string> = {
  workday: 'name,slug,url\nAcme workday,acme/ext,https://acme.wd1.myworkdayjobs.com/ext\n',
  eightfold: 'name,slug,url,domain\nAcme eightfold,acme,https://acme.eightfold.ai/careers,acme.com\n',
}
const csv = (provider: string) => addressed[provider] ?? `name,slug,url\nAcme ${provider},acme-${provider},https://x.example/acme\n"Foo, Bar Inc",foo-bar,https://x.example/foo\nBad Slug,not/a/token,https://x.example/bad\n`

const routine = (args: Record<string, unknown> = {}): RoutineRow => ({ id: 'r1', user_id: null, command: 'directory.seed', args, local_time: '04:00', every: null, timezone: 'UTC', next_due_at: null, enabled: true, slice: null })

function setup(over: { args?: Record<string, unknown>; state?: Record<string, unknown> | null; deadlineAt?: number; deps?: Partial<SeedDeps> } = {}) {
  const sent: { p_rows: { source: string; ats_provider: string | null; ats_token: string | null; name: string }[] }[] = []
  const { client, tables } = fakeDb({ routines: [{ id: 'r1', args: over.args ?? {} }] }, { rpc: { upsert_directory_candidates: (a) => (sent.push(a as never), (a.p_rows as unknown[]).length) } })
  const ctx: RoutineContext = { admin: client, routine: routine(over.args), userId: null, state: over.state ?? null, now: () => NOW, deadlineAt: over.deadlineAt ?? NOW + 200_000 }
  const deps: SeedDeps = {
    fetchKalil: async (p) => csv(p),
    fetchYc: async () => [{ name: 'Retell AI', website: 'https://www.retellai.com/', tags: ['AI', 'Voice'], one_liner: 'Voice agents', batch: 'W24', isHiring: true, url: 'https://www.ycombinator.com/companies/retell-ai' }],
    ...over.deps,
  }
  return { ctx, deps, sent, tables }
}

describe('parseKalil', () => {
  it('reads the canonical shape, quoted names, and leaves out a slug that cannot be a board token', () => {
    const rows = parseKalil(csv('greenhouse'), 'greenhouse')
    expect(rows.map((r) => [r.name, r.ats_token])).toEqual([['Acme greenhouse', 'acme-greenhouse'], ['Foo, Bar Inc', 'foo-bar']])
    expect(rows[1]).toMatchObject({ name_norm: 'foo bar', ats_provider: 'greenhouse', source: 'kalil', domain: null })
  })

  it('reads the older two-column files, where the second column is the bare slug', () => {
    expect(parseKalil('name,url\nAcme,acme\n', 'lever').map((r) => r.ats_token)).toEqual(['acme'])
  })

  it('reads a Workday board from its address, and an Eightfold board from its address and domain', () => {
    const workday = 'name,slug,url\n3M,3m/search,https://3m.wd1.myworkdayjobs.com/search\nBad,x/y,https://example.com/jobs\n'
    expect(parseKalil(workday, 'workday').map((r) => [r.name, r.ats_token])).toEqual([['3M', '3m.wd1.search']])
    const eightfold = 'name,slug,url,domain\nAlbemarle,albemarle,https://albemarle.eightfold.ai/careers,albemarle.com\n10x Genomics,10xgenomics,https://10xgenomics.eightfold.ai/careers,\n'
    expect(parseKalil(eightfold, 'eightfold').map((r) => [r.name, r.ats_token, r.ats_provider])).toEqual([['Albemarle', 'albemarle.eightfold.ai_albemarle.com', 'eightfold']])
    expect(() => parseKalil('name,slug\n3M,3m/search\n', 'workday')).toThrow(/unexpected header/)
  })

  it('refuses a list whose header changed, and drops a repeated slug', () => {
    expect(() => parseKalil('company,board\nAcme,acme\n', 'lever')).toThrow(/unexpected header/)
    expect(parseKalil('name,slug,url\nAcme,acme,x\nACME 2,ACME,x\n', 'lever')).toHaveLength(1)
  })
})

describe('ycRows', () => {
  it('keeps a hiring company with a website, by its domain, with what YC says about it', () => {
    const rows = ycRows([
      { name: 'Retell AI', website: 'https://www.retellai.com/', tags: ['AI'], industries: ['B2B'], one_liner: 'Voice agents', batch: 'W24', team_size: 12, isHiring: true, url: 'https://www.ycombinator.com/companies/retell-ai' },
      { name: 'No site', isHiring: true },
      { name: 'Twin', website: 'https://retellai.com', isHiring: true },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ domain: 'retellai.com', source: 'yc', tags: ['ai', 'b2b'], batch: 'W24', team_size: 12, ats_provider: null, profile_url: 'https://www.ycombinator.com/companies/retell-ai' })
  })
})

describe('directory.seed', () => {
  it('loads both lists as candidates, never as employers, and stamps when each was loaded', async () => {
    const { ctx, deps, sent, tables } = setup()
    const r = await seedWith(ctx, deps)
    expect(r.ok).toBe(true)
    const rows = sent.flatMap((s) => s.p_rows)
    expect(rows.filter((x) => x.source === 'yc')).toHaveLength(1)
    expect(new Set(rows.filter((x) => x.source === 'kalil').map((x) => x.ats_provider))).toEqual(new Set(KALIL_PROVIDERS))
    expect(tables.company_directory ?? []).toEqual([])
    expect(tables.routines[0].args).toMatchObject({ yc_at: new Date(NOW).toISOString(), kalil_at: new Date(NOW).toISOString() })
  })

  it('does nothing while both lists are fresh', async () => {
    const fresh = { yc_at: new Date(NOW - 86_400_000).toISOString(), kalil_at: new Date(NOW - 5 * 86_400_000).toISOString() }
    const { ctx, deps, sent } = setup({ args: fresh })
    expect(await seedWith(ctx, deps)).toMatchObject({ ok: true, found: { yc: 0, kalil: 0 } })
    expect(sent).toEqual([])
  })

  it('reloads YC after a week and the tenant lists after a month, each by itself', async () => {
    const { ctx, deps, sent } = setup({ args: { yc_at: new Date(NOW - 8 * 86_400_000).toISOString(), kalil_at: new Date(NOW - 3 * 86_400_000).toISOString() } })
    await seedWith(ctx, deps)
    expect(sent.flatMap((s) => s.p_rows).every((x) => x.source === 'yc')).toBe(true)
  })

  it('stops between providers at its deadline and hands the next one on', async () => {
    const { ctx, deps, sent } = setup({ deadlineAt: NOW - 1 })
    const r = await seedWith(ctx, deps)
    expect(r).toMatchObject({ ok: true, next: { phase: 'kalil', at: 0 } })
    expect(sent.flatMap((s) => s.p_rows).every((x) => x.source === 'yc')).toBe(true)
    // the next slice carries on from there and does not load YC again
    const next = setup({ state: r.next ?? null, args: { yc_at: new Date(NOW).toISOString() } })
    const done = await seedWith(next.ctx, next.deps)
    expect(done).toMatchObject({ ok: true })
    expect(next.sent.flatMap((s) => s.p_rows).filter((x) => x.source === 'yc')).toEqual([])
    expect(new Set(next.sent.flatMap((s) => s.p_rows).map((x) => x.ats_provider))).toEqual(new Set(KALIL_PROVIDERS))
  })

  it('fails loudly when a list changed shape, and stamps nothing for it', async () => {
    const { ctx, deps, tables } = setup({ deps: { fetchKalil: async () => 'company,board\nAcme,acme\n' } })
    expect(await seedWith(ctx, deps)).toMatchObject({ ok: false, failure: 'seed_format_changed' })
    expect(tables.routines[0].args).not.toHaveProperty('kalil_at')
  })

  it('an empty YC answer is a failure, and the tenant lists still load', async () => {
    const { ctx, deps, sent } = setup({ deps: { fetchYc: async () => [] } })
    expect(await seedWith(ctx, deps)).toMatchObject({ ok: false, failure: 'yc_list_empty' })
    expect(sent.length).toBeGreaterThan(0)
  })
})
