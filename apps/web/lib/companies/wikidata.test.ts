import { describe, expect, it, vi } from 'vitest'
import { lookupWikidata, registrable, toProfile, wikidataByQid } from './wikidata'

const claim = (value: unknown, rank = 'normal', qualifiers?: unknown) => ({ rank, mainsnak: { datavalue: { value } }, ...(qualifiers ? { qualifiers } : {}) })
const entity = (id: string) => ({ value: { 'entity-type': 'item', id } })

// A trimmed answer of wbgetentities: an employer with every fact, a fruit with none, and a namesake with a website only.
const ITEMS = {
  Q1: {
    labels: { en: { value: 'Retell AI' } },
    claims: {
      P856: [claim('https://www.retellai.com/')],
      P159: [claim(entity('Q62').value)],
      P1128: [claim({ amount: '+40' }, 'normal', { P585: [{ datavalue: { value: { time: '+2023-00-00T00:00:00Z' } } }] }), claim({ amount: '+75' }, 'normal', { P585: [{ datavalue: { value: { time: '+2025-00-00T00:00:00Z' } } }] })],
      P452: [claim(entity('Q11661').value)],
      P154: [claim('Retell AI logo.svg')],
      P571: [claim({ time: '+2023-00-00T00:00:00Z' })],
      P249: [claim('RTL', 'deprecated')],
      P2037: [claim('retell-ai')],
    },
  },
  Q2: { labels: { en: { value: 'Retell' } }, claims: {} },
  Q3: { labels: { en: { value: 'Retell' } }, claims: { P856: [claim('https://retell.co.uk/jobs')] } },
}
const LABELS = { Q62: { labels: { en: { value: 'San Francisco' } } }, Q11661: { labels: { en: { value: 'information technology' } } } }

function wikidata() {
  return vi.fn(async (p: Record<string, string>) => {
    if (p.action === 'wbsearchentities') return { search: [{ id: 'Q1', label: 'Retell AI' }, { id: 'Q2', label: 'Retell' }, { id: 'Q3', label: 'Retell' }] }
    if (p.props === 'labels') return { entities: LABELS }
    return { entities: ITEMS }
  })
}

describe('registrable', () => {
  it('keeps the domain a site is registered under', () => {
    expect(registrable('https://www.retellai.com/careers')).toBe('retellai.com')
    expect(registrable('https://jobs.careers.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrable('retell.ai')).toBe('retell.ai')
  })
  it('refuses what is not a public host', () => {
    for (const bad of ['localhost', 'http://10.0.0.1/x', 'not a url', '']) expect(registrable(bad)).toBeNull()
  })
})

describe('lookupWikidata', () => {
  it('turns the claims of an item with a website into its profile, in three requests', async () => {
    const get = wikidata()
    const found = await lookupWikidata('Retell AI', get, () => Date.parse('2026-10-21T10:00:00Z'))
    expect(get).toHaveBeenCalledTimes(3)
    expect(get.mock.calls[0][0]).toMatchObject({ action: 'wbsearchentities', type: 'item', language: 'en', limit: '3' })
    expect(found).toHaveLength(2)
    expect(found[0]).toEqual({
      qid: 'Q1',
      label: 'Retell AI',
      website: 'https://www.retellai.com/',
      hq: 'San Francisco',
      employees: 75, // the newest dated statement
      industry: 'information technology',
      logo: 'https://commons.wikimedia.org/wiki/Special:FilePath/Retell%20AI%20logo.svg',
      founded: 2023,
      ticker: null, // a deprecated statement is no value
      github: 'retell-ai',
      fetchedAt: '2026-10-21T10:00:00.000Z',
    })
  })

  it('drops an item with no official website, keeps two namesakes that have one, and stores the facts with their source', async () => {
    const found = await lookupWikidata('Retell', wikidata())
    expect(found.map((f) => f.qid)).toEqual(['Q1', 'Q3'])
    expect(found[1]).toMatchObject({ hq: null, employees: null, industry: null, logo: null, founded: null })
    expect(toProfile(found[0])).toMatchObject({ source: 'wikidata', qid: 'Q1', fetched_at: found[0].fetchedAt })
  })

  it('is empty for no match and asks nothing more, and lets a Wikidata outage through', async () => {
    const none = vi.fn(async () => ({ search: [] }))
    expect(await lookupWikidata('Zzzzz', none)).toEqual([])
    expect(none).toHaveBeenCalledTimes(1)
    expect(await lookupWikidata('  ', none)).toEqual([])
    await expect(lookupWikidata('Retell', async () => { throw new Error('wikidata 503') })).rejects.toThrow('503')
  })

  it('reads one item by its Q-id and refuses anything that is not one', async () => {
    expect((await wikidataByQid('Q1', wikidata()))?.website).toBe('https://www.retellai.com/')
    expect(await wikidataByQid('Q1; drop', wikidata())).toBeNull()
  })
})
