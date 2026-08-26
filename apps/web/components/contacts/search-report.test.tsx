// The empty state used to be one hard-coded sentence ("nothing usable in the
// job posting or company research yet") that was true regardless of what ran —
// so a run that fetched six pages and a run that fetched nothing looked
// identical, and the user's read was "we are not doing ample search". These
// tests pin the replacement: the sources are named, the volume actually read
// is shown, and a source that was SKIPPED says so with its reason.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { SearchReport } from '@/lib/contacts/sources'
import { ContactSearchReport } from './search-report'

// Shaped exactly like a real empty run: everything free was consulted, the
// two BYOK providers were skipped for want of a key.
const EMPTY_RUN: SearchReport = {
  headline:
    'No contacts found. Searched the job posting (14,200 characters) and the company website (6 pages) — none of them named a person or published an email address. Not searched: Hunter.io email database (no Hunter.io API key configured).',
  steps: [
    {
      key: 'posting',
      label: 'the job posting',
      status: 'empty',
      scanned: '14,200 characters',
      found: 0,
      detail: 'the posting text names no person and quotes no email address',
    },
    {
      key: 'site',
      label: 'acme.com',
      status: 'found',
      scanned: '6 pages',
      found: 2,
      detail: 'read the home, about, team, careers, leadership and contact pages',
    },
    {
      key: 'hunter',
      label: 'Hunter.io email database',
      status: 'skipped',
      scanned: null,
      found: 0,
      detail: 'no Hunter.io API key configured — add one in Settings to search a real email database (optional)',
    },
    {
      key: 'apollo',
      label: 'Apollo.io people search',
      status: 'error',
      scanned: null,
      found: 0,
      detail: 'the provider returned an error',
    },
  ],
  domain: 'acme.com',
  domainBasis: 'companies.domain (acme.com)',
}

function render(report: SearchReport): string {
  return renderToStaticMarkup(createElement(ContactSearchReport, { report }))
}

describe('ContactSearchReport', () => {
  it('renders the route headline verbatim instead of a canned sentence', () => {
    const html = render(EMPTY_RUN)
    expect(html).toContain('Searched the job posting')
    expect(html).not.toContain('nothing usable in the job posting or company research yet')
  })

  it('names every source, how much was read, and what it produced', () => {
    const html = render(EMPTY_RUN)
    expect(html).toContain('the job posting')
    expect(html).toContain('14,200 characters')
    expect(html).toContain('6 pages')
    expect(html).toContain('2 found')
    expect(html).toContain('nothing found')
  })

  it('distinguishes not-searched from searched-and-empty, with the reason', () => {
    const html = render(EMPTY_RUN)
    expect(html).toContain('not searched')
    expect(html).toContain('no Hunter.io API key configured')
    expect(html).toContain('search failed')
  })

  it('states which domain the domain-gated sources ran against', () => {
    expect(render(EMPTY_RUN)).toContain('ran against acme.com')
  })

  it('explains the missing domain rather than showing a blank when there is none', () => {
    const html = render({
      ...EMPTY_RUN,
      domain: null,
      domainBasis: 'no employer domain on file — the company record, the dossier and the posting URL all lack one',
    })
    expect(html).toContain('No employer domain to search')
    expect(html).toContain('no employer domain on file')
  })
})
