import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { classifyJob, isLowQuality, type Classification } from '@/lib/jobs/classify'
import { resolveTargeting, isTargetingConfigured, type Targeting } from '@/lib/targeting'

// Simple job extractor that works without Python dependencies
// Uses fetch + cheerio-like parsing via regex
//
// Every candidate title, regardless of where it came from (JSON-LD, real
// anchor text, or the AI extractor), is validated through classifyJob before
// it is ever considered for insertion. Titles are NEVER synthesized from a
// URL path slug — that was the source of "Stuttgart"/"Potsdam"/"Backend"
// showing up as job titles.

const MAX_JOB_CANDIDATES = 200

interface ExtractedJob {
  title: string
  url: string
  location?: string
  description?: string
}

async function fetchAndExtractJobs(careerUrl: string, companyName: string): Promise<ExtractedJob[]> {
  try {
    const response = await fetch(careerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })

    if (!response.ok) {
      console.error(`Failed to fetch ${careerUrl}: ${response.status}`)
      return []
    }

    const html = await response.text()
    const jobs: ExtractedJob[] = []

    // Try to find JSON-LD structured data first (most reliable) — this is a
    // real, structured JobPosting object, not a guess from a URL.
    const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
    for (const match of jsonLdMatches) {
      try {
        const data = JSON.parse(match[1])
        const items = Array.isArray(data) ? data : [data]
        for (const item of items) {
          if (item['@type'] === 'JobPosting') {
            const title = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : ''
            if (!title.trim()) continue
            jobs.push({
              title,
              url: typeof item.url === 'string' && item.url ? item.url : careerUrl,
              location: typeof item.jobLocation === 'string'
                ? item.jobLocation
                : item.jobLocation?.address?.addressLocality || item.jobLocation?.name,
              description: item.description?.substring(0, 500),
            })
          }
        }
      } catch {}
    }

    if (jobs.length > 0) {
      console.log(`Found ${jobs.length} jobs via JSON-LD for ${companyName}`)
      return jobs
    }

    // Fallback: job cards/listings whose anchor text IS the title — real text
    // a human reading the page would see, never a slug derived from the href.
    const jobCardPatterns = [
      /<(?:div|li|article)[^>]*class=["'][^"']*(?:job|position|opening|career)[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi,
      /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*(?:job|position)[^"']*["'][^>]*>([^<]+)<\/a>/gi,
    ]

    for (const pattern of jobCardPatterns) {
      const matches = html.matchAll(pattern)
      for (const match of matches) {
        let url = match[1]
        const title = match[2]?.trim()
        if (!title) continue

        if (url.startsWith('/')) {
          const base = new URL(careerUrl)
          url = `${base.origin}${url}`
        } else if (!url.startsWith('http')) {
          continue
        }

        // Avoid duplicates
        if (!jobs.some((j) => j.url === url)) {
          jobs.push({ title, url })
        }
      }
    }

    console.log(`Found ${jobs.length} jobs via HTML parsing for ${companyName}`)
    return jobs
  } catch (error) {
    console.error(`Error scraping ${careerUrl}:`, error)
    return []
  }
}

/** Strict shape validation for the AI extractor's JSON output — never trust it verbatim. */
function validateAiJobs(raw: unknown, careerUrl: string): ExtractedJob[] {
  if (!Array.isArray(raw)) return []
  const base = (() => {
    try {
      return new URL(careerUrl).origin
    } catch {
      return undefined
    }
  })()

  const out: ExtractedJob[] = []
  for (const item of raw.slice(0, MAX_JOB_CANDIDATES)) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>

    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    if (!title || title.length > 300) continue

    const rawUrl = typeof obj.url === 'string' ? obj.url.trim() : ''
    if (!rawUrl) continue
    let url: URL
    try {
      url = new URL(rawUrl, base)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue

    const location = typeof obj.location === 'string' ? obj.location.trim().slice(0, 200) : undefined

    out.push({ title, url: url.toString(), location: location || undefined })
  }
  return out
}

// Use AI to extract jobs (if API keys available)
async function extractJobsWithAI(
  careerUrl: string,
  companyName: string,
  apiKey: string,
  provider: 'openrouter' | 'openai' | 'anthropic'
): Promise<ExtractedJob[]> {
  try {
    const response = await fetch(careerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })

    if (!response.ok) return []

    const html = await response.text()

    // Clean HTML - remove scripts, styles, etc.
    const cleanHtml = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .substring(0, 15000)

    // Extract all links for context
    const linkMatches = html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi)
    const links: Array<{url: string, text: string}> = []
    for (const match of linkMatches) {
      const text = match[2]?.trim()
      if (text && text.length > 2 && text.length < 100) {
        links.push({ url: match[1], text })
      }
    }

    const prompt = `You are a career page analyzer extracting job listings from ${companyName}'s careers page.

## INPUT DATA

**Page URL:** ${careerUrl}
**Base URL for relative links:** ${new URL(careerUrl).origin}

### Page Content (cleaned HTML):
${cleanHtml}

### Links Found on Page (first 50):
${JSON.stringify(links.slice(0, 50), null, 2)}

---

## YOUR ANALYSIS PROCESS

<think>
Step 1: IDENTIFY THE PAGE TYPE
- Is this a job listing page or a single job description page?
- Is this an ATS (Greenhouse, Lever, Workday, etc.) or custom?
- Are there navigation links to other job categories?

Step 2: LOCATE JOB LISTINGS
- Look for repeating patterns (cards, list items, table rows)
- Check for job-related keywords in links: /jobs/, /careers/, /positions/
- Look for structured data (job titles paired with locations, departments)

Step 3: EXTRACT EACH JOB
For each job found:
- Title: Extract the exact job title (don't infer or abbreviate)
- URL: Build the full absolute URL from the href
- Location: Look for city, state, country, or "Remote"

Step 4: VALIDATE
- Verify URLs look like job posting links (not navigation, login, etc.)
- Check that titles look like real job titles (not "Learn More", "Apply Now")
- Remove duplicates
</think>

---

## EXTRACTION RULES

**INCLUDE:**
- Job titles that are clearly roles (e.g., "Senior Software Engineer", "Product Manager")
- Links that point to individual job postings
- Location information when clearly associated with a job

**EXCLUDE:**
- Navigation links ("Home", "About Us", "Contact")
- Generic call-to-action buttons ("Apply Now", "Learn More", "View All")
- Department/category headers unless they're actual job titles
- Login/signup links
- Social media links

**URL HANDLING:**
- Relative URLs starting with "/" → prepend ${new URL(careerUrl).origin}
- Already absolute URLs → use as-is
- Relative paths without "/" → prepend the full base URL

---

## OUTPUT FORMAT

Return ONLY a valid JSON array, no markdown, no explanation:

[
  {"title": "Exact Job Title", "url": "https://full-absolute-url", "location": "City, State or Remote"}
]

If no jobs are found, return: []`

    let aiResponse: string = ''

    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://cello.app',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
        }),
      })
      const data = await res.json()
      aiResponse = data.choices?.[0]?.message?.content || ''
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
        }),
      })
      const data = await res.json()
      aiResponse = data.choices?.[0]?.message?.content || ''
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const data = await res.json()
      aiResponse = data.content?.[0]?.text || ''
    }

    // Parse JSON response — never trust it verbatim, validate shape strictly.
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch (error) {
      console.error(`AI response was not valid JSON for ${companyName}:`, error)
      return []
    }

    const jobs = validateAiJobs(parsed, careerUrl)
    const candidateCount = Array.isArray(parsed) ? parsed.length : 0
    console.log(`AI extracted ${jobs.length} valid jobs (of ${candidateCount} candidates) for ${companyName}`)
    return jobs
  } catch (error) {
    console.error('AI extraction failed:', error)
    return []
  }
}

interface ClassifiedCandidate {
  job: ExtractedJob
  classification: Classification
}

/** Run every candidate through the shared classifier; drop rejects/near-zero quality. */
function classifyAndGate(jobs: ExtractedJob[], companyName: string): ClassifiedCandidate[] {
  const out: ClassifiedCandidate[] = []
  for (const job of jobs.slice(0, MAX_JOB_CANDIDATES)) {
    const classification = classifyJob({
      title: job.title,
      description: job.description,
      location: job.location,
      companyName,
    })
    if (classification.rejectReason || isLowQuality(classification)) continue
    out.push({ job, classification })
  }
  return out
}

/**
 * Replaces the old dead "usaPatterns/filteredJobs" block. When the user has
 * configured targeting, honor it (country/language/remote/function/seniority
 * + exclusions) using the classifier's output rather than a hardcoded
 * US-only regex. Unknown country/language never excludes a candidate — an
 * unparseable location is not evidence the job is wrong, just evidence the
 * classifier couldn't tell.
 */
function matchesTargeting(candidate: ClassifiedCandidate, companyName: string, targeting: Targeting): boolean {
  const { classification, job } = candidate
  if (targeting.countries.length > 0 && classification.country && !targeting.countries.includes(classification.country)) {
    return false
  }
  if (targeting.languages.length > 0 && classification.language !== 'unknown' && !targeting.languages.includes(classification.language)) {
    return false
  }
  if (targeting.remoteOnly && !classification.isRemote) return false
  if (targeting.functions.length > 0 && !targeting.functions.includes(classification.jobFunction)) return false
  if (targeting.seniority.length > 0 && !targeting.seniority.includes(classification.seniority)) return false
  if (targeting.excludedCompanies.includes(companyName.toLowerCase())) return false
  if (targeting.excludedKeywords.length > 0) {
    const hay = `${job.title} ${job.description ?? ''}`.toLowerCase()
    if (targeting.excludedKeywords.some((kw) => hay.includes(kw))) return false
  }
  return true
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { companyId } = body

  if (!companyId) {
    return NextResponse.json({ error: 'Company ID required' }, { status: 400 })
  }

  // Get company details
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .eq('user_id', user.id)
    .single()

  if (companyError || !company) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  }

  console.log(`Starting scrape for ${company.name} (${company.career_url})`)

  // Get user's API keys for AI-powered extraction, and their targeting prefs.
  const { getDecryptedApiKeys } = await import('@/lib/apikeys')
  const [apiKeys, profileResult] = await Promise.all([
    getDecryptedApiKeys(user.id),
    supabase.from('profiles').select('preferences').eq('id', user.id).single(),
  ])
  const targeting = resolveTargeting(profileResult.data?.preferences)
  const targetingActive = isTargetingConfigured(targeting)

  let jobs: ExtractedJob[] = []

  // Try AI extraction first if keys available
  if (apiKeys.openrouter) {
    jobs = await extractJobsWithAI(company.career_url, company.name, apiKeys.openrouter, 'openrouter')
  } else if (apiKeys.anthropic) {
    jobs = await extractJobsWithAI(company.career_url, company.name, apiKeys.anthropic, 'anthropic')
  } else if (apiKeys.openai) {
    jobs = await extractJobsWithAI(company.career_url, company.name, apiKeys.openai, 'openai')
  }

  // Fallback to basic extraction
  if (jobs.length === 0) {
    jobs = await fetchAndExtractJobs(company.career_url, company.name)
  }

  const rawCount = jobs.length
  const classified = classifyAndGate(jobs, company.name)
  const accepted = targetingActive
    ? classified.filter((c) => matchesTargeting(c, company.name, targeting))
    : classified

  // Only insert candidates we haven't already seen for this company, so a
  // re-scrape never resets an existing row's discovered_at/is_new/match_score
  // (that reset is exactly what broke freshness filtering elsewhere).
  const { data: existingRows } = await supabase
    .from('jobs')
    .select('external_id')
    .eq('company_id', companyId)
  const existingIds = new Set((existingRows ?? []).map((r) => r.external_id).filter(Boolean))
  const newCandidates = accepted.filter(({ job }) => !existingIds.has(job.url))

  let insertedCount = 0
  if (newCandidates.length > 0) {
    const now = new Date().toISOString()
    const rows = newCandidates.map(({ job, classification }) => ({
      company_id: companyId,
      title: job.title.slice(0, 300),
      description: job.description || '',
      url: job.url,
      location: job.location || null,
      external_id: job.url, // Use URL as unique identifier
      is_new: true,
      discovered_at: now,
      job_function: classification.jobFunction,
      seniority: classification.seniority,
      language: classification.language,
      country: classification.country,
      is_remote: classification.isRemote,
      job_type: classification.jobType,
      quality_score: classification.qualityScore,
      source: 'scraper' as const,
    }))

    const { error } = await supabase
      .from('jobs')
      .upsert(rows, { onConflict: 'company_id,external_id', ignoreDuplicates: false })

    if (!error) {
      insertedCount = rows.length
    } else {
      console.error(`Failed to upsert jobs for ${company.name}: ${error.message}`)
    }
  }

  // Update last_scraped_at
  await supabase
    .from('companies')
    .update({ last_scraped_at: new Date().toISOString() })
    .eq('id', companyId)

  console.log(
    `Scrape complete for ${company.name}: ${rawCount} candidates -> ${classified.length} passed quality -> ` +
    `${accepted.length} passed targeting -> ${insertedCount} newly inserted`
  )

  return NextResponse.json({
    success: true,
    company: company.name,
    jobsFound: accepted.length,
    jobsInserted: insertedCount,
    rawCandidates: rawCount,
    rejectedForQuality: rawCount - classified.length,
    rejectedForTargeting: classified.length - accepted.length,
    message: accepted.length > 0
      ? `Found ${accepted.length} jobs at ${company.name}`
      : rawCount > 0
        ? `Found ${rawCount} candidates at ${company.name} but none passed quality/targeting checks`
        : `No jobs found. Try adding API keys in Settings for AI-powered extraction.`,
  })
}
