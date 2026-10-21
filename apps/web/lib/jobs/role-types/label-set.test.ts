import { describe, expect, it } from 'vitest'
import { chooseLabelRows, collectFileRows, importLabelSet, labelSetCsv, parseLabelCsv, parseScoredRows, scoreLabels, scoreReport } from './label-set'
import { fakeDb } from '../../companies/fake-db'

const held = (n: number, title: string, type: string | null, over: Record<string, unknown> = {}) => ({
  id: `j${n}`,
  title,
  title_norm: title.toLowerCase(),
  role_type: type,
  viewer_company_name: 'Acme',
  saved_at: null,
  ...over,
})

describe('the label set', () => {
  it('takes one row for each distinct title, every type the owner holds before a second of any, and the untyped ones too', () => {
    const rows = chooseLabelRows(
      [
        held(1, 'AI Engineer', 'ai-engineer'),
        held(2, 'ai engineer', 'ai-engineer', { id: 'j2' }),
        held(3, 'Applied AI Engineer', 'ai-engineer'),
        held(4, 'LLM Engineer', 'ai-engineer'),
        held(5, 'Data Engineer', 'data-engineer'),
        held(6, 'Product Manager', 'product-manager'),
        held(7, 'Zookeeper', null),
        held(8, 'Chief Happiness Officer', null),
      ],
      new Set(),
      6
    )
    // one round across the types the owner holds (the biggest first, the untyped last in a round), then the next
    expect(rows.map((r) => r.title_norm)).toEqual(['ai engineer', 'data engineer', 'product manager', 'chief happiness officer', 'applied ai engineer', 'zookeeper'])
    expect(new Set(rows.map((r) => r.title_norm)).size).toBe(rows.length)
    expect(rows).toHaveLength(6)
  })

  it('prefers a role the owner applied to over one only kept, for the same title', () => {
    const rows = chooseLabelRows([held(1, 'AI Engineer', 'ai-engineer'), held(2, 'AI Engineer', 'ai-engineer', { id: 'j2', saved_at: '2026-10-01' })], new Set(['j1']), 10)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('applied')
  })

  it('stops at 100 and ignores a role with no normalised title', () => {
    const many = Array.from({ length: 150 }, (_, i) => held(i, `Title ${i}`, 'software-engineer'))
    expect(chooseLabelRows([...many, held(999, 'No Key', null, { title_norm: null })], new Set())).toHaveLength(100)
  })

  it('writes a CSV with a blank column to mark, and reads the marked rows back', () => {
    const csv = labelSetCsv([{ title: 'Engineer, "Platform"', title_norm: 'engineer platform', tier1_type: '', employer: 'Acme, Inc', source: 'kept' }])
    expect(csv.split('\n')[0]).toBe('title,title_norm,cello_type,type,employer,source')
    expect(csv).toContain('"Engineer, ""Platform"""')
    const marked = csv.replace(',,"Acme, Inc"', ',platform-engineer,"Acme, Inc"')
    expect(parseLabelCsv(marked)).toEqual({ labelled: [{ title: 'Engineer, "Platform"', title_norm: 'engineer platform', role_type: 'platform-engineer' }], refused: [] })
  })

  it('skips an unmarked row, accepts none, and refuses a type the taxonomy does not have', () => {
    const csv = ['title,title_norm,tier1_type,your_type,employer,source', 'A,a,,,x,kept', 'B,b,,none,x,kept', 'C,c,,forged-type,x,kept', 'D,d,,OTHER,x,kept', 'E,e,,AI-Engineer,x,kept'].join('\n')
    const out = parseLabelCsv(csv)
    expect(out.labelled.map((l) => [l.title, l.role_type])).toEqual([['B', 'none'], ['E', 'ai-engineer']])
    expect(out.refused).toEqual(['C: forged-type', 'D: other'])
  })

  it('imports the marked titles as the dataset role-types, and says what is missing from the environment', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = []
    const fake = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
      return { ok: true, status: 200 }
    }) as unknown as typeof fetch
    const env = { LANGFUSE_BASE_URL: 'https://langfuse.example/', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }
    const out = await importLabelSet([{ title: 'AI Engineer', title_norm: 'ai engineer', role_type: 'ai-engineer' }], env, fake)
    expect(out).toEqual({ imported: 1 })
    expect(calls.map((c) => c.url)).toEqual(['https://langfuse.example/api/public/datasets', 'https://langfuse.example/api/public/dataset-items'])
    expect(calls[1].body).toMatchObject({ datasetName: 'role-types', id: 'role-types:ai engineer', expectedOutput: { role_type: 'ai-engineer' } })
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`)
    await expect(importLabelSet([], {}, fake)).rejects.toThrow('LANGFUSE_BASE_URL')
  })
})

describe('the file mode', () => {
  it('fills a set the owner does not fill with the most common stored titles, once each', async () => {
    const jobs = [
      ...Array.from({ length: 3 }, () => ({ title: 'Software Engineer', title_norm: 'software engineer', role_type: 'software-engineer' })),
      ...Array.from({ length: 2 }, () => ({ title: 'Data Engineer', title_norm: 'data engineer', role_type: 'data-engineer' })),
      { title: 'Zookeeper', title_norm: 'zookeeper', role_type: null },
      { title: 'No key', title_norm: null, role_type: null },
    ]
    const rows = await collectFileRows(fakeDb({ jobs }).client, null, 3)
    expect(rows.map((r) => [r.title_norm, r.tier1_type, r.source])).toEqual([['software engineer', 'software-engineer', 'common'], ['data engineer', 'data-engineer', 'common'], ['zookeeper', '', 'common']])
  })
})

describe('scoring the marked file', () => {
  const rows = (n: number, cello: string, label: string) => Array.from({ length: n }, () => ({ cello, label }))

  it('reads the marked rows with either name of the column', () => {
    expect(parseScoredRows('title,title_norm,cello_type,type\nA,a,ai-engineer,ai-engineer\nB,b,,')).toEqual([{ cello: 'ai-engineer', label: 'ai-engineer' }])
    expect(parseScoredRows('title,title_norm,tier1_type,your_type\nA,a,,None')).toEqual([{ cello: '', label: 'none' }])
  })

  it('gives precision and recall for a type with 10 labels, says too few for the rest, and reads the gate', () => {
    // 10 ai labels: Cello gave 9 of them ai and 1 untyped, and gave ai to 1 title the owner calls backend
    const marked = [...rows(9, 'ai-engineer', 'ai-engineer'), ...rows(1, '', 'ai-engineer'), ...rows(1, 'ai-engineer', 'backend-engineer'), ...rows(3, 'backend-engineer', 'backend-engineer'), ...rows(2, '', 'none')]
    const score = scoreLabels(marked, null)
    expect(score.perType).toEqual([{ type: 'ai-engineer', labels: 10, precision: 0.9, recall: 0.9 }, { type: 'backend-engineer', labels: 4, precision: null, recall: null }])
    // 14 wanted titles, 13 kept (the untyped one is not)
    expect(score).toMatchObject({ keepRecall: 0.929, keepN: 14, gate: false })
    expect(scoreReport(score, false)).toEqual([
      'ai-engineer: 10 labels, precision 0.9, recall 0.9',
      'backend-engineer: 4 labels. Too few to tell',
      'Keep-recall over every type you marked (pass --chosen to narrow it): 0.929 on 14 titles',
      'The 0.95 gate does not hold',
    ])
  })

  it('counts keep-recall over the chosen types only, and holds the gate at 0.95', () => {
    const marked = [...rows(19, 'ai-engineer', 'ai-engineer'), ...rows(1, '', 'ai-engineer'), ...rows(5, '', 'designer')]
    expect(scoreLabels(marked, ['ai-engineer'])).toMatchObject({ keepRecall: 0.95, keepN: 20, gate: true })
    expect(scoreLabels(marked, ['data-analyst'])).toMatchObject({ keepRecall: null, gate: null })
  })
})
