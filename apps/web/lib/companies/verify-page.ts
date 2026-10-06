// The model half of the careers page check (POST /api/companies/verify): what
// the model is given, and how its answer is trusted. The prompt itself is
// prompts/company_verify.md.
//
// The page text is whatever the site says about itself, so it goes in as data
// inside the untrusted frame, and a yes needs a quote: `evidence` must be text
// that really is on the page. A verdict that says "official" without a quote
// the page contains is capped at 0.4 confidence, which the route reads as not
// verified.

import { composeSystemPrompt, loadModeDoc } from '@/lib/harness/prompts'
import { frameJobText } from '@/lib/security/job-text'

export interface AIAnalysis {
  isCareerPage: boolean
  companyName: string | null
  estimatedJobCount: number
  confidence: number
  reasoning: string
  isOfficialPage: boolean
  evidence: string
}

/** Page text handed to the model: tags and scripts removed, whitespace folded, capped. */
export function pageTextFromHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000)
}

/** The system and user halves of the check. */
export function buildVerifyPrompt(url: string, pageText: string): { system: string; prompt: string } {
  return {
    system: composeSystemPrompt({ mode: loadModeDoc('company_verify'), includeVoice: false }),
    prompt: `URL: ${url}\n\nPAGE:\n${frameJobText(pageText, { label: 'PAGE', emptyPlaceholder: '(the page had no text)' })}`,
  }
}

/** Is the quote on the page? Whitespace and case are ignored, nothing else. */
export function quoteIsOnPage(quote: string, pageText: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()
  const q = norm(quote)
  return q.length >= 8 && norm(pageText).includes(q)
}

/** The model's JSON, trusted only as far as its types and its evidence: anything else is a miss, not a verdict. */
export function parseAnalysis(content: string, pageText: string): AIAnalysis | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof raw.isCareerPage !== 'boolean' || typeof raw.isOfficialPage !== 'boolean') return null
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : ''
  let confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0
  // "Official" must come with words the page really contains.
  if (raw.isOfficialPage && !quoteIsOnPage(evidence, pageText)) confidence = Math.min(confidence, 0.4)
  return {
    isCareerPage: raw.isCareerPage,
    isOfficialPage: raw.isOfficialPage,
    companyName: typeof raw.companyName === 'string' ? raw.companyName : null,
    estimatedJobCount:
      typeof raw.estimatedJobCount === 'number' && Number.isFinite(raw.estimatedJobCount)
        ? Math.max(0, Math.round(raw.estimatedJobCount))
        : 0,
    confidence,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    evidence,
  }
}
