import { describe, expect, it } from 'vitest'
import { buildVocabulary, isSimilar, sharedTags, tagsFromText } from './similarity'

// 100 companies: "b2b" on 40 (generic), "fintech" on 10, "payments" on 2, "ai" on 1.
function directory() {
  const rows: { tags: string[] }[] = []
  for (let i = 0; i < 100; i++) {
    const tags: string[] = []
    if (i < 40) tags.push('B2B')
    if (i < 10) tags.push('Fintech')
    if (i < 2) tags.push('Payments')
    if (i === 5) tags.push('AI')
    if (i >= 60 && i < 75) tags.push('Developer Tools')
    rows.push({ tags })
  }
  return rows
}

describe('buildVocabulary', () => {
  it('counts each tag once per company, case-insensitively', () => {
    const v = buildVocabulary([{ tags: ['SaaS', 'saas', 'Fintech'] }, { tags: ['SaaS'] }, { tags: null }])
    expect(v.n).toBe(3)
    expect(v.df.get('saas')).toBe(2)
    expect(v.df.get('fintech')).toBe(1)
  })
})

describe('sharedTags', () => {
  const vocab = buildVocabulary(directory())

  it('ignores tags more than 15% of companies carry', () => {
    const a = new Set(['b2b', 'fintech'])
    const b = new Set(['b2b', 'fintech', 'payments'])
    expect(sharedTags(a, b, vocab)).toEqual(['fintech'])
  })

  it('orders by rarity and only keeps tags present in the vocabulary', () => {
    const a = new Set(['fintech', 'payments', 'unknown tag'])
    const b = new Set(['fintech', 'payments', 'unknown tag'])
    expect(sharedTags(a, b, vocab)).toEqual(['payments', 'fintech'])
  })
})

describe('isSimilar', () => {
  const vocab = buildVocabulary(directory())

  it('counts two shared tags, or one rare tag, but not one common tag', () => {
    expect(isSimilar(['fintech', 'developer tools'], vocab)).toBe(true)
    expect(isSimilar(['payments'], vocab)).toBe(true) // 2% of companies
    expect(isSimilar(['fintech'], vocab)).toBe(false) // 10%
    expect(isSimilar([], vocab)).toBe(false)
  })
})

describe('tagsFromText', () => {
  const vocab = buildVocabulary(directory())

  it('finds vocabulary tags as whole words and phrases', () => {
    const found = tagsFromText('We build payments infrastructure and Developer Tools for fintech teams.', vocab)
    expect([...found].sort()).toEqual(['developer tools', 'fintech', 'payments'])
  })

  it('does not match a tag inside a longer word (no "ai" in "detail")', () => {
    expect(tagsFromText('Pay attention to detail, maintain a clean domain', vocab).has('ai')).toBe(false)
    expect(tagsFromText('We use AI to read invoices', vocab).has('ai')).toBe(true)
  })
})
