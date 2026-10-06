import { describe, expect, it } from 'vitest'
import { chooseLabelRows, importLabelSet, labelSetCsv, parseLabelCsv } from './label-set'

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
    expect(csv.split('\n')[0]).toBe('title,title_norm,tier1_type,your_type,employer,source')
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
