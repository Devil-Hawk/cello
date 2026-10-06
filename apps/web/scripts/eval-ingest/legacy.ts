// The careers page prompt this package replaced, ported from the Python page
// reader (OpenRouterProvider.extract_jobs in packages/scrapers/src/intelligent.py
// at b195472) so the old and new prompts are scored by the same verifier on the
// same pages. Only the f-string became a template literal; the words are the
// same. The page's text is cut at 30,000 characters and the first 100 links are
// shown as JSON, as the old reader did.

import type { PageSnapshot } from '../../lib/ingest/snapshot'

export function legacyPageReaderPrompt(snap: PageSnapshot): string {
  const links = JSON.stringify(
    snap.links.slice(0, 100).map((l) => ({ text: l.label, href: l.href })),
    null,
    2
  )
  return `You are an expert job listing extractor. Extract ALL job listings.

## INPUT DATA

**URL:** ${snap.url}

### Page Content (cleaned):
${snap.text.slice(0, 30000)}

### Links Found (may contain job URLs):
${links}

---

## YOUR ANALYSIS PROCESS

<think>
Step 1: IDENTIFY PAGE TYPE
- Is this a job listing page (many jobs) or single job page?
- What ATS or format is used? (Greenhouse, Lever, Workday, custom)

Step 2: LOCATE JOB ENTRIES
- Find repeating patterns (cards, list items, etc.)
- Identify job-related links vs navigation links

Step 3: EXTRACT FOR EACH JOB
- title: Exact job title
- url: Full absolute URL to the job posting
- location: City/State/Remote if mentioned
- description: Brief summary if visible
- salary: Pay range if mentioned
- type: Full-time/Part-time/Contract
- posted_at: Date if visible
- id: Job ID if visible

Step 4: VALIDATE
- Are these real job titles or navigation elements?
- Are URLs pointing to actual job pages?
- Remove duplicates
</think>

---

## EXTRACTION RULES

INCLUDE: Real job titles (e.g., "Senior Engineer", "Product Manager")
EXCLUDE: Navigation ("Home", "About"), CTAs ("Apply Now", "Learn More")

Return ONLY a valid JSON array of job objects. No markdown, no explanation:

[
  {
    "title": "Job Title",
    "url": "https://...",
    "location": "City, State",
    "description": "...",
    "salary": "...",
    "type": "Full-time",
    "posted_at": "...",
    "id": "..."
  }
]

If no jobs found, return: []`
}

/** The old reader's answer is a JSON array of {title, url, ...}. */
export function parseLegacyAnswer(raw: string): { title: string; url: string }[] | null {
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const arr = JSON.parse(match[0]) as unknown
    if (!Array.isArray(arr)) return null
    return arr
      .filter((x): x is { title: string; url?: string } => !!x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string')
      .map((x) => ({ title: x.title, url: typeof x.url === 'string' ? x.url : '' }))
  } catch {
    return null
  }
}
