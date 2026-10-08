// What is working on fixtures: Keep says where it acts, a kept finding says so, the two role groups carry See them
// only where Roles can filter, and a page with nothing to say shows the thresholds, never a chart of zeros.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResultsPanel } from './findings'
import type { ResultsView, ViewFinding } from '@/lib/strategy/results'

const html = (view: ResultsView) => renderToStaticMarkup(<ResultsPanel view={view} onKeep={() => undefined} onNotRight={() => undefined} />).replace(/<!-- -->/g, '')

const finding = (over: Partial<ViewFinding> = {}): ViewFinding => ({ key: 'outcome:sourceFunnel:referral', dimension: 'source', line: '5 of 9 applications from Referral got a reply.', applications: 9, replies: 5, change: 'Show roles from Referral first', acts: 'Which roles come first in Roles.', proposal: null, keep: { effect: 'rank.fresh', params: {} }, state: 'new', ...over })
const empty: ResultsView = { working: [], notWorking: [], noticed: [], thresholds: [], source: [], spread: [] }

describe('What is working', () => {
  it('a new finding shows its counts, the change, where Keep acts, and Keep and Not right', () => {
    const out = html({ ...empty, working: [finding()] })
    expect(out).toContain('5 of 9 applications from Referral got a reply.')
    expect(out).toContain('Show roles from Referral first. If you keep it, it changes: Which roles come first in Roles.')
    expect(out).toContain('>Keep<')
    expect(out).toContain('>Not right<')
  })

  it('a kept finding says what it changes and where to turn it off, with no buttons', () => {
    const out = html({ ...empty, working: [finding({ state: 'kept' })] })
    expect(out).toContain('Kept: Show roles from Referral first. It changes: Which roles come first in Roles.')
    expect(out).toContain('Turn it off in')
    expect(out).not.toContain('>Keep<')
  })

  it('a finding with nothing to keep is a line and nothing else', () => {
    const out = html({ ...empty, notWorking: [finding({ key: 'chance:stretch', change: null, acts: null, keep: null, line: '1 of 10 applications on Stretch roles got a reply (10%).' })] })
    expect(out).toContain('1 of 10 applications on Stretch roles got a reply (10%).')
    expect(out).not.toContain('>Keep<')
    expect(out).not.toContain('>Not right<')
  })

  it('shows what Cello noticed with its own Keep', () => {
    const out = html({ ...empty, noticed: [finding({ key: 'proposal:chanceAccuracy:x', line: 'Consider skipping Stretch roles.', change: 'Keep Stretch roles out of the shortlist', acts: 'The suggestions for your search.' })] })
    expect(out).toContain('Cello noticed')
    expect(out).toContain('Consider skipping Stretch roles.')
    expect(out).toContain('>Keep<')
  })

  it('with nothing to say shows the threshold sentences and no groups', () => {
    const out = html({ ...empty, thresholds: ['Reply rates by role type appear from 15 applications.'] })
    expect(out).toContain('Nothing to say yet.')
    expect(out).toContain('Reply rates by role type appear from 15 applications.')
    expect(out).not.toContain('Where your roles come from')
    expect(out).not.toContain('How your roles spread')
  })
})

describe('Where your roles come from and how they spread', () => {
  it('lists each group with its count, and See them only where Roles can filter by it', () => {
    const out = html({
      ...empty,
      source: [{ id: 'followed', label: 'Employers you follow, from their own sites', n: 14, href: '/roles?following=1' }, { id: 'untraced', label: 'Not traced to an employer', n: 3, href: null }],
      spread: [{ id: 'strong', label: 'Strong', n: 4, href: '/roles?chance=strong' }, { id: 'unchecked', label: 'Not checked yet', n: 1, href: null }],
    })
    expect(out).toContain('Where your roles come from')
    expect(out).toContain('14 roles')
    expect(out).toContain('1 role<')
    expect(out).toContain('href="/roles?following=1"')
    expect(out).toContain('href="/roles?chance=strong"')
    expect((out.match(/See them/g) ?? []).length).toBe(2)
  })
})
