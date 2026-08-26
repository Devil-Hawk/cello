// Regression guard for the KB-persistence wiring the langgraph port step 4
// added: raw page text must land in the KB BEFORE synthesis reasons over it
// (synthesis never gets a second look at pub.homeText/aboutText/careersText —
// this is the only place that text is ever captured), and the synthesized
// summary must land AFTER. Every dependency is mocked; this test is entirely
// about CALL ORDER, not about what any one dependency computes.

import { describe, expect, it, vi } from 'vitest'

const callLog: string[] = []

vi.mock('@/lib/dossier/sources', () => ({
  collectPublicSignals: vi.fn(async () => {
    callLog.push('collectPublicSignals')
    return {
      wikipediaSummary: undefined,
      news: [],
      github: undefined,
      homeText: 'Home page text about Acme.',
      aboutText: 'About Acme, a widget maker.',
      careersText: undefined,
      sources: [],
    }
  }),
}))

vi.mock('@/lib/dossier/comp', () => ({
  computeCompIntel: vi.fn(() => ({ rangeLow: null, rangeHigh: null, source: 'none', confidence: 'low' })),
}))

vi.mock('@/lib/dossier/visa', () => ({
  resolveVisaSignal: vi.fn(async () => ({ signal: 'unknown' })),
}))

vi.mock('@/lib/dossier/store', () => ({
  upsertDossier: vi.fn(async (_client: unknown, row: { company_id: string }) => {
    callLog.push('upsertDossier')
    return { id: 'dossier-1', company_id: row.company_id }
  }),
}))

vi.mock('@/lib/kb/ingest', () => ({
  ingestCompanyPage: vi.fn(async (_admin: unknown, _userId: string, _companyId: string, page: string) => {
    callLog.push(`ingestCompanyPage:${page}`)
  }),
  ingestDossierSummary: vi.fn(async () => {
    callLog.push('ingestDossierSummary')
  }),
}))

import { generateDossier } from './company_researcher'
import { ingestCompanyPage, ingestDossierSummary } from '@/lib/kb/ingest'
import type { LlmRunOptions, LlmResult } from '../types'

const fakeAdmin = {} as never

async function runFakeLlm(_opts: LlmRunOptions): Promise<LlmResult> {
  callLog.push('llm-synthesis')
  return {
    content: JSON.stringify({
      summary: 'Acme makes widgets.',
      whatTheyWant: null,
      uncertainty: null,
      funding: null,
      headcountTrend: null,
      culture: null,
      techStack: [],
    }),
    tokensUsed: 10,
    promptTokens: 5,
    completionTokens: 5,
    model: 'test-model',
  }
}

describe('generateDossier persists raw page text before synthesis, the summary after', () => {
  it('calls ingestCompanyPage for every available page before the LLM synthesis call, and ingestDossierSummary only after', async () => {
    callLog.length = 0
    await generateDossier({
      company: { id: 'company-1', name: 'Acme', domain: 'acme.com' },
      jobs: [],
      llm: runFakeLlm,
      admin: fakeAdmin,
      userId: 'user-1',
    })

    // homeText and aboutText were present (careersText was not) — exactly
    // those two pages are persisted, both before the synthesis call.
    const homeIdx = callLog.indexOf('ingestCompanyPage:home')
    const aboutIdx = callLog.indexOf('ingestCompanyPage:about')
    const synthIdx = callLog.indexOf('llm-synthesis')
    const summaryIdx = callLog.indexOf('ingestDossierSummary')

    expect(homeIdx).toBeGreaterThanOrEqual(0)
    expect(aboutIdx).toBeGreaterThanOrEqual(0)
    expect(synthIdx).toBeGreaterThan(homeIdx)
    expect(synthIdx).toBeGreaterThan(aboutIdx)
    expect(summaryIdx).toBeGreaterThan(synthIdx)
    expect(callLog).not.toContain('ingestCompanyPage:careers')

    expect(vi.mocked(ingestCompanyPage)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(ingestDossierSummary)).toHaveBeenCalledWith(
      fakeAdmin,
      'user-1',
      'company-1',
      'Acme makes widgets.'
    )
  })

  it('never calls ingestDossierSummary when there is nothing to summarize (no key, no signals)', async () => {
    callLog.length = 0
    await generateDossier({
      company: { id: 'company-2', name: 'NoKey Co', domain: null },
      jobs: [],
      admin: fakeAdmin,
      userId: 'user-1',
    })
    expect(callLog).not.toContain('ingestDossierSummary')
  })
})
