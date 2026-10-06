// Made-up employers and roles for fixture pages. None of these is a real company.

export interface FixtureCompany {
  name: string
  domain: string
}

export const COMPANIES: FixtureCompany[] = [
  { name: 'Vantage Loom', domain: 'vantageloom.example' },
  { name: 'Orchid Ledger', domain: 'orchidledger.example' },
  { name: 'Petrichor Labs', domain: 'petrichor.example' },
  { name: 'Harbor Quill', domain: 'harborquill.example' },
  { name: 'Tessera Grid', domain: 'tesseragrid.example' },
  { name: 'Lumen Parcel', domain: 'lumenparcel.example' },
]

const TITLES = [
  'AI Engineer',
  'Forward Deployed Engineer',
  'Senior Data Engineer',
  'Machine Learning Engineer, Ranking',
  'Platform Engineer',
  'Analytics Engineer',
  'Staff Software Engineer, Applied AI and Developer Experience for Regulated Industries',
]

export interface FixtureRow {
  id: string
  title: string
  company: FixtureCompany
  place: string
  posted: string
}

export function fixtureRows(count: number): FixtureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `fx-${i + 1}`,
    title: TITLES[i % TITLES.length],
    company: COMPANIES[i % COMPANIES.length],
    place: i % 3 === 0 ? 'Remote, US' : 'New York',
    posted: i % 4 === 0 ? 'Posted 5h ago' : 'Posted 3 days ago',
  }))
}
