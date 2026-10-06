import { describe, expect, it } from 'vitest'
import { buildVerifyPrompt, pageTextFromHtml, parseAnalysis, quoteIsOnPage } from './verify-page'
import { getPolicyDoc } from '@/lib/harness/prompts'

const PAGE = 'Northwind. Open positions. Data Analyst, Seattle. Backend Engineer, Remote.'
const verdict = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ isCareerPage: true, isOfficialPage: true, companyName: 'Northwind', estimatedJobCount: 2, confidence: 0.9, evidence: 'Open positions. Data Analyst, Seattle.', reasoning: 'ok', ...over })

describe('parseAnalysis', () => {
  it('keeps an official verdict whose quote is on the page', () => {
    expect(parseAnalysis(verdict(), PAGE)).toMatchObject({ isOfficialPage: true, confidence: 0.9, companyName: 'Northwind' })
  })

  it('caps confidence at 0.4 when an official verdict has no quote, or a quote the page does not contain', () => {
    expect(parseAnalysis(verdict({ evidence: '' }), PAGE)?.confidence).toBe(0.4)
    expect(parseAnalysis(verdict({ evidence: 'This is the official careers page' }), PAGE)?.confidence).toBe(0.4)
    expect(parseAnalysis(verdict({ confidence: 0.2, evidence: '' }), PAGE)?.confidence).toBe(0.2)
  })

  it('does not touch the confidence of a verdict that is not official', () => {
    expect(parseAnalysis(verdict({ isOfficialPage: false, evidence: '', confidence: 0.9 }), PAGE)?.confidence).toBe(0.9)
  })

  it('treats anything that is not a typed verdict as a miss', () => {
    expect(parseAnalysis('no json here', PAGE)).toBeNull()
    expect(parseAnalysis('{"isCareerPage": "maybe"}', PAGE)).toBeNull()
    expect(parseAnalysis('{bad', PAGE)).toBeNull()
  })

  it('quote matching ignores case and spacing only', () => {
    expect(quoteIsOnPage('OPEN   positions. data analyst', PAGE)).toBe(true)
    expect(quoteIsOnPage('Open positions. Data Scientist', PAGE)).toBe(false)
    expect(quoteIsOnPage('Data', PAGE)).toBe(false)
  })
})

describe('the prompt', () => {
  it('composes the policy and the document, and frames the page as untrusted data', () => {
    const { system, prompt } = buildVerifyPrompt('https://northwind.example/careers', PAGE)
    expect(system.startsWith(getPolicyDoc())).toBe(true)
    expect(system).toContain('Decide whether a web page is a company')
    expect(prompt).toContain('URL: https://northwind.example/careers')
    expect(prompt).toMatch(/\[\[BEGIN UNTRUSTED PAGE [0-9a-f]+\]\]\nNorthwind\./)
  })

  it('strips scripts and tags from html and caps the text', () => {
    const text = pageTextFromHtml(`<style>a{}</style><script>var x=1</script><h1>Careers</h1> <p>${'word '.repeat(5000)}</p>`)
    expect(text.startsWith('Careers word')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).not.toContain('var x')
  })
})
