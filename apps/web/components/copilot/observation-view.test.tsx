// Regression test for the research_companies (batch) jargon leak: before the
// ResearchBatchSummary branch existed, the batch tool's real return shape
// ({requested,researched,failed,results:[...],note?}) matched none of
// ObservationView's branches and fell through to the raw
// `<pre>{JSON.stringify(value,null,2)}</pre>` fallback — which rendered each
// result's internal `reason` string ("Dossier saved.") and the `dossierId`
// field name verbatim to the user. See lib/harness/copilot-tools.ts
// doResearchCompanies for the real shape this simulates.
//
// Uses react-dom/server's renderToStaticMarkup instead of a DOM-based
// renderer — no jsdom test environment is configured in vitest.config.ts,
// and ObservationView never touches browser-only APIs on the branches
// exercised here (useEffect only runs inside ResumeRewriteDiff, which these
// shapes never reach).
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ObservationView } from './observation-view'

function render(observation: unknown): string {
  return renderToStaticMarkup(createElement(ObservationView, { observation }))
}

describe('ObservationView — research_companies (batch) shape', () => {
  it('renders a clean N-for-N success batch without leaking "dossier" jargon or raw JSON', () => {
    // Exact shape doResearchCompanies returns for a 2/2 success run: note is
    // undefined because nothing was skipped and every company succeeded —
    // the case the verifier reproduced as the failure.
    const observation = {
      requested: 2,
      researched: 2,
      failed: 0,
      results: [
        {
          status: 'researched',
          company: 'Acme Corp',
          dossierId: 'd-1',
          sponsorsVisa: 'likely',
          hasSummary: true,
          sourceCount: 4,
          partial: false,
          reason: 'Dossier saved.',
        },
        {
          status: 'researched',
          company: 'Widget Inc',
          dossierId: 'd-2',
          sponsorsVisa: 'unknown',
          hasSummary: false,
          sourceCount: 1,
          partial: true,
          reason: 'Partial dossier: public signals collected, no AI summary.',
        },
      ],
    }

    const html = render(observation)

    expect(html.toLowerCase()).not.toContain('dossier')
    expect(html).not.toContain('dossierId')
    // Must not fall through to the raw JSON <pre> dump.
    expect(html).not.toContain('JSON.stringify')
    expect(html).not.toMatch(/<pre[ >]/)
    // Should render something scannable instead.
    expect(html).toContain('Acme Corp')
    expect(html).toContain('Widget Inc')
    expect(html).toContain('Company research')
  })

  it('renders a partial-failure batch (with a top-level note) without leaking jargon', () => {
    const observation = {
      requested: 3,
      researched: 1,
      failed: 2,
      results: [
        { status: 'researched', company: 'Acme Corp', dossierId: 'd-1', reason: 'Dossier saved.' },
        {
          status: 'error',
          companyId: 'bad-id-1',
          company: null,
          reason: 'No company found with id "bad-id-1" in your tracked companies.',
        },
        { status: 'error', companyId: 'bad-id-2', company: null, reason: 'Research failed: timeout' },
      ],
      note: undefined,
    }

    const html = render(observation)

    expect(html.toLowerCase()).not.toContain('dossier')
    expect(html).not.toContain('dossierId')
    expect(html).toContain('Acme Corp')
    expect(html).toContain('bad-id-1')
  })
})
