import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/context/assemble', () => ({ outreachHistory: async () => ({ lines: [], patterns: [] }) }))
vi.mock('@/lib/dossier/facts', () => ({ companyFacts: async () => [] }))

import { loadOutreachSources } from './sources'

const check = (who: string) => ({ requirement: who, status: 'met', evidence: { line: 1, quote: `${who} quote` } })
const roles = [
  { viewer_id: 'other', chance_detail: { checks: [check('Other')] } },
  { viewer_id: 'me', chance_detail: { checks: [check('Mine')] } },
]

// A service client returns every holder's role row unless the query filters on the viewer.
function client() {
  const eqs: Record<string, unknown> = {}
  const q: Record<string, unknown> = {}
  q.select = () => q
  q.eq = (col: string, val: unknown) => ((eqs[col] = val), q)
  q.single = async () => {
    const rows = 'viewer_id' in eqs ? roles.filter((r) => r.viewer_id === eqs['viewer_id']) : roles
    return { data: { id: 'j1', title: 'Engineer', description: 'd', viewer_company_id: null, ...rows[0] } }
  }
  return { from: () => q } as never
}

describe('loadOutreachSources', () => {
  it('never takes another follower’s verdict into the highlights', async () => {
    const supabase = client()
    const out = await loadOutreachSources({ supabase, admin: supabase, userId: 'me', userEmail: 'm@x.co', contactId: null, jobId: 'j1', companyId: null })
    expect(out.input.matchHighlights).toEqual(['Mine: Mine quote'])
  })
})
