import { describe, expect, it } from 'vitest'
import { dossierView, evidenceLine } from './present'
import type { DossierSignals } from './store'

const signals: DossierSignals = {
  sourceList: [
    { id: 'S1', kind: 'home', title: 'Acme site', url: 'https://acme.test' },
    { id: 'S2', kind: 'careers', title: 'Acme careers', url: 'https://acme.test/careers' },
    { id: 'S3', kind: 'news', title: 'Acme raises Series B', url: 'https://news.test/a' },
    { id: 'S4', kind: 'news', title: 'Acme opens office', url: 'https://news.test/b' },
    { id: 'S5', kind: 'github', title: 'GitHub', url: 'https://github.com/acme' },
  ],
  citations: [
    { field: 'summary', text: 'Acme makes anvils.', sources: ['S1'] },
    { field: 'summary', text: 'It is hiring engineers.', sources: ['S2', 'S1'] },
    { field: 'funding', text: 'A headline reports a Series B.', sources: ['S3'] },
    { field: 'techStack', text: 'Go', sources: ['S2'] },
  ],
  evidence: { kinds: ['home', 'careers', 'news', 'github'], wikipediaOnly: false },
  dropped: 2,
}

describe('dossierView', () => {
  it('numbers sources by first use and marks each statement with them', () => {
    const v = dossierView(signals)
    expect(v.summary).toEqual([
      { text: 'Acme makes anvils.', marks: [1] },
      { text: 'It is hiring engineers.', marks: [2, 1] },
    ])
    expect(v.field('funding')).toEqual({ text: 'A headline reports a Series B.', marks: [3] })
    expect(v.cited.map((s) => [s.n, s.title])).toEqual([
      [1, 'Acme site'],
      [2, 'Acme careers'],
      [3, 'Acme raises Series B'],
    ])
  })

  it('lists the sources that were read but not cited, and the dropped count', () => {
    const v = dossierView(signals)
    expect(v.other.map((s) => s.title)).toEqual(['Acme opens office', 'GitHub'])
    expect(v.dropped).toBe(2)
    expect(v.hasCitations).toBe(true)
  })

  it('says what the research rests on', () => {
    expect(evidenceLine(signals)).toBe('Based on the company site, the careers page, GitHub and 2 news mentions.')
    expect(evidenceLine({ sourceList: [{ id: 'S1', kind: 'news', title: 't', url: 'u' }] })).toBe('Based on 1 news mention.')
    expect(evidenceLine({})).toBeNull()
  })

  it('treats research from before statements were cited as having no citations', () => {
    const v = dossierView({ funding: 'Series B' })
    expect(v.hasCitations).toBe(false)
    expect(v.summary).toEqual([])
  })
})
