import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { assertSsrfSafe } from '@/lib/security/untrusted'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { callLlm } from '@/lib/harness/llm'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { warnLlmFallback } from '@/lib/observability/llm-fallback'
import { lookupKnownCompanyByDomain, faviconForDomain } from '@/lib/companies/known-companies'

interface VerificationResult {
  isValid: boolean
  status: string
  message: string
  companyName: string | null
  logoUrl: string | null
  jobCount: number
  confidence: number
  aiVerified: boolean
}

interface AIAnalysis {
  isCareerPage: boolean
  companyName: string | null
  estimatedJobCount: number
  confidence: number
  reasoning: string
  isOfficialPage: boolean
}

// Fallback keywords for heuristic verification
const JOB_URL_PATTERNS = [
  'career', 'careers', 'job', 'jobs', 'join', 'hiring',
  'opportunities', 'work-with-us', 'work-for-us', 'vacancies',
  'recruitment', 'talent', 'team',
]

const JOB_KEYWORDS = [
  'career', 'careers', 'job', 'jobs', 'position', 'positions',
  'opening', 'openings', 'opportunity', 'opportunities',
  'hiring', 'join us', 'work with us', 'employment',
  'apply', 'application', 'full-time', 'part-time', 'remote',
]

/** Cheap on purpose: one short yes/no assessment of a page. */
const VERIFY_MODEL = 'openai/gpt-4o-mini'

/** Give up on the AI and use the heuristic rather than stall the add-company dialog. */
const AI_TIMEOUT_MS = 20_000

const VERIFY_SYSTEM_PROMPT = `You are an expert at analyzing web pages to determine if they are legitimate company career pages.
Analyze the provided page content and URL to determine:
1. Is this an official company careers/jobs page (not a job board like Indeed or LinkedIn)?
2. What is the exact company name?
3. Approximately how many job listings are visible?
4. How confident are you in this assessment (0-1)?

Respond in JSON format only:
{
  "isCareerPage": boolean,
  "isOfficialPage": boolean,
  "companyName": string | null,
  "estimatedJobCount": number,
  "confidence": number,
  "reasoning": "brief explanation"
}`

/** The model's JSON, trusted only as far as its types: anything else is a miss, not a verdict. */
function parseAnalysis(content: string): AIAnalysis | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof raw.isCareerPage !== 'boolean' || typeof raw.isOfficialPage !== 'boolean') return null
  return {
    isCareerPage: raw.isCareerPage,
    isOfficialPage: raw.isOfficialPage,
    companyName: typeof raw.companyName === 'string' ? raw.companyName : null,
    estimatedJobCount:
      typeof raw.estimatedJobCount === 'number' && Number.isFinite(raw.estimatedJobCount)
        ? Math.max(0, Math.round(raw.estimatedJobCount))
        : 0,
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.min(1, Math.max(0, raw.confidence))
        : 0,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
  }
}

/**
 * AI verification through callLlm, so it is budget-checked, spend-recorded and
 * traced like every other model call. Any failure (no key, a spent budget, a
 * 402, a retired model, a timeout, unparseable output) returns null and logs
 * why; the caller then runs the heuristic verifier.
 */
async function analyzeWithLlm(apiKeys: DecryptedApiKeys, html: string, url: string): Promise<AIAnalysis | null> {
  try {
    // Extract text content, limiting size
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000)

    const result = await callLlm(
      apiKeys,
      {
        model: VERIFY_MODEL,
        system: VERIFY_SYSTEM_PROMPT,
        prompt: `URL: ${url}\n\nPage content:\n${textContent}`,
        temperature: 0.1,
        maxTokens: 500,
        // The account-wide default effort would add thinking tokens to a call that never used them.
        reasoning: { effort: 'none' },
      },
      AbortSignal.timeout(AI_TIMEOUT_MS)
    )
    const analysis = parseAnalysis(result.content)
    if (!analysis) warnLlmFallback('company-verify', 'heuristic', new Error('model output was not a usable verdict'))
    return analysis
  } catch (error) {
    warnLlmFallback('company-verify', 'heuristic', error)
    return null
  }
}

function heuristicVerification(html: string, url: string, domain: string): Omit<VerificationResult, 'aiVerified'> {
  const urlLower = url.toLowerCase()
  const textLower = html.toLowerCase()
  const urlHasJobPattern = JOB_URL_PATTERNS.some(p => urlLower.includes(p))

  // Count job keywords
  const keywordMatches = JOB_KEYWORDS.filter(kw => textLower.includes(kw)).length

  // Estimate job count from patterns
  let jobCount = 0
  const patterns = [
    /<a[^>]*href="[^"]*\/jobs?\/[^"]*"/gi,
    /class="[^"]*job[^"]*-?card[^"]*"/gi,
    /class="[^"]*position[^"]*-?item[^"]*"/gi,
  ]
  for (const p of patterns) {
    const matches = html.match(p)
    if (matches) jobCount = Math.max(jobCount, matches.length)
  }

  // Extract company name - check known companies first
  let companyName: string | null = null

  // Check known companies directory
  const knownCompany = lookupKnownCompanyByDomain(domain)
  if (knownCompany) {
    companyName = knownCompany.name
  }

  // Try og:site_name
  if (!companyName) {
    const ogMatch = html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i)
    if (ogMatch && ogMatch[1].length < 40) {
      companyName = ogMatch[1].trim()
        .replace(/\s*careers?$/i, '')
        .replace(/\s*jobs?$/i, '')
        .trim()
    }
  }

  // Try page title
  if (!companyName) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    if (titleMatch) {
      let title = titleMatch[1]
        .replace(/\s*[-|–—:]\s*careers?$/i, '')
        .replace(/\s*[-|–—:]\s*jobs?$/i, '')
        .replace(/^careers?\s*(at|[-|])?\s*/i, '')
        .replace(/^jobs?\s*(at|[-|])?\s*/i, '')
        .trim()
      const atMatch = title.match(/^(?:careers?|jobs?)\s+at\s+(.+)$/i)
      if (atMatch) title = atMatch[1]
      if (title.length > 0 && title.length < 50) {
        companyName = title.split(/\s*[-|–—]\s*/)[0].trim()
      }
    }
  }

  // Fallback to cleaned domain
  if (!companyName) {
    const baseDomain = domain.replace(/^(jobs|careers|www)\./, '').split('.')[0]
    companyName = baseDomain.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }

  // Calculate confidence
  let confidence = 0.3
  if (urlHasJobPattern) confidence += 0.2
  if (keywordMatches >= 3) confidence += 0.2
  if (jobCount > 0) confidence += 0.1
  confidence = Math.min(confidence, 0.7) // Cap at 0.7 without AI

  const isValid = confidence >= 0.5 || (urlHasJobPattern && confidence >= 0.3)

  return {
    isValid,
    status: isValid ? 'verified' : 'unverified',
    message: isValid
      ? `Career page detected (heuristic). ${jobCount > 0 ? `~${jobCount} jobs found.` : 'Enable AI for better accuracy.'}`
      : 'Could not verify as career page. Check URL or add API keys for AI verification.',
    companyName,
    logoUrl: faviconForDomain(domain),
    jobCount,
    confidence: Math.round(confidence * 100) / 100,
  }
}

/** Redirect hops allowed while verifying a career page. http -> https -> www. */
const MAX_VERIFY_REDIRECTS = 3

export async function POST(request: NextRequest) {
  try {
    // AUTHENTICATE BEFORE FETCHING ANYTHING.
    //
    // This route takes a URL from the request body and fetches it. Until now
    // the only auth.getUser() call sat AFTER that fetch, where it decided
    // whether to also run AI analysis — so an entirely UNAUTHENTICATED POST
    // could make this server issue an arbitrary GET and read back a verdict on
    // what came out. That is a server-side request forgery with a result
    // oracle, reachable by anyone who can reach the deployment: point it at
    // 169.254.169.254 or at an internal service and the response tells you
    // whether it answered and roughly what it said.
    //
    // Authentication is not itself the SSRF fix (the guard below is), but an
    // unauthenticated fetch primitive should not exist at all, and moving this
    // up costs nothing: every real caller is a signed-in user adding a company.
    const authClient = await createClient()
    const {
      data: { user: requestingUser },
    } = await authClient.auth.getUser()
    if (!requestingUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { url } = body

    if (!url) {
      return NextResponse.json({
        isValid: false,
        status: 'error',
        message: 'URL is required',
        companyName: null,
        logoUrl: null,
        jobCount: 0,
        confidence: 0,
        aiVerified: false,
      } satisfies VerificationResult)
    }

    // Normalize URL
    let normalizedUrl = url.trim()
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(normalizedUrl)
    } catch {
      return NextResponse.json({
        isValid: false,
        status: 'invalid_url',
        message: 'Invalid URL format. Example: https://company.com/careers',
        companyName: null,
        logoUrl: null,
        jobCount: 0,
        confidence: 0,
        aiVerified: false,
      } satisfies VerificationResult)
    }

    const domain = parsedUrl.hostname.replace(/^www\./, '')
    // For logo, use parent domain (amazon.jobs → amazon.com)
    const logoUrl = faviconForDomain(domain)

    // Fetch the page
    let html = ''
    let fetchSuccess = false

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    ]

    // ONLY http(s). Without this, `file:`, `gopher:` and friends are reachable
    // through the same primitive, and some of them read local disk.
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return NextResponse.json({
        isValid: false,
        status: 'invalid_url',
        message: 'Only http and https URLs can be verified.',
        companyName: null,
        logoUrl: null,
        jobCount: 0,
        confidence: 0,
        aiVerified: false,
      } satisfies VerificationResult)
    }

    for (const ua of userAgents) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 12000)

        // Follow redirects BY HAND so every hop is checked.
        //
        // `redirect: 'follow'` validated nothing: the caller's URL could be a
        // perfectly ordinary public host that 302s straight to
        // http://169.254.169.254/latest/meta-data/, and the fetch would take
        // that hop without anything looking at it. assertSsrfSafe resolves the
        // name and refuses loopback, link-local, RFC1918 and cloud-metadata
        // addresses — which is also what stops a public hostname whose DNS
        // record simply POINTS at a private address, the case a hostname
        // allowlist can never catch.
        //
        // Its limits are documented in lib/security/untrusted.ts: the check
        // resolves DNS itself and the fetch resolves again, so a resolver that
        // answers differently between the two can still slip through. Closing
        // that needs a connection pinned to the verified address.
        let target = normalizedUrl
        let res: Response | null = null

        for (let hop = 0; hop <= MAX_VERIFY_REDIRECTS; hop++) {
          await assertSsrfSafe(target)
          const hopRes = await fetch(target, {
            signal: controller.signal,
            headers: {
              'User-Agent': ua,
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'manual',
          })
          if (hopRes.status >= 300 && hopRes.status < 400) {
            const location = hopRes.headers.get('location')
            if (!location) break
            target = new URL(location, target).toString()
            continue
          }
          res = hopRes
          break
        }

        clearTimeout(timeout)

        if (res?.ok) {
          html = await res.text()
          fetchSuccess = true
          break
        }
      } catch {
        // Includes an SSRF refusal. Falls through to the same "could not fetch"
        // path as a timeout, so the response body does not become an oracle
        // distinguishing "blocked" from "unreachable".
        continue
      }
    }

    if (!fetchSuccess) {
      // Check if URL looks like a career page even without fetching
      const urlHasJobPattern = JOB_URL_PATTERNS.some(p => normalizedUrl.toLowerCase().includes(p))
      if (urlHasJobPattern) {
        const guessedName = domain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        return NextResponse.json({
          isValid: true,
          status: 'unverified',
          message: 'Could not fetch page, but URL looks like a career page. Will monitor.',
          companyName: guessedName,
          logoUrl,
          jobCount: 0,
          confidence: 0.4,
          aiVerified: false,
        } satisfies VerificationResult)
      }

      return NextResponse.json({
        isValid: false,
        status: 'unreachable',
        message: 'Could not connect to the URL. Please check and try again.',
        companyName: null,
        logoUrl: null,
        jobCount: 0,
        confidence: 0,
        aiVerified: false,
      } satisfies VerificationResult)
    }

    // AI verification, only for a signed-in user whose keys load. Keys come from
    // the guarded request-context loader (demo spend and expiry guards apply);
    // callLlm does the budget check, spend record and trace. Every failure,
    // including an expired demo or a spent budget, degrades to the heuristic.
    let aiAnalysis: AIAnalysis | null = null

    let apiKeys: DecryptedApiKeys | null = null
    try {
      apiKeys = await getDecryptedApiKeys(requestingUser.id)
    } catch (error) {
      warnLlmFallback('company-verify', 'heuristic', error)
    }
    if (apiKeys && canRunLlm(apiKeys)) {
      aiAnalysis = await analyzeWithLlm(apiKeys, html, normalizedUrl)
    }

    // If AI analysis succeeded, use it
    if (aiAnalysis) {
      const isValid = aiAnalysis.isCareerPage && aiAnalysis.isOfficialPage && aiAnalysis.confidence >= 0.6

      let message = ''
      if (isValid) {
        message = `AI verified: ${aiAnalysis.reasoning}`
        if (aiAnalysis.estimatedJobCount > 0) {
          message = `AI verified career page with ~${aiAnalysis.estimatedJobCount} jobs. ${aiAnalysis.reasoning}`
        }
      } else if (aiAnalysis.isCareerPage && !aiAnalysis.isOfficialPage) {
        message = `This appears to be a job board, not an official company career page. ${aiAnalysis.reasoning}`
      } else {
        message = `AI analysis: ${aiAnalysis.reasoning}`
      }

      return NextResponse.json({
        isValid,
        status: isValid ? 'ai_verified' : 'ai_rejected',
        message,
        companyName: aiAnalysis.companyName,
        logoUrl: isValid ? logoUrl : null,
        jobCount: aiAnalysis.estimatedJobCount,
        confidence: aiAnalysis.confidence,
        aiVerified: true,
      } satisfies VerificationResult)
    }

    // Fall back to heuristic verification
    const heuristicResult = heuristicVerification(html, normalizedUrl, domain)

    return NextResponse.json({
      ...heuristicResult,
      aiVerified: false,
    } satisfies VerificationResult)

  } catch (error) {
    console.error('Verification error:', error)
    return NextResponse.json({
      isValid: false,
      status: 'error',
      message: 'An unexpected error occurred. Please try again.',
      companyName: null,
      logoUrl: null,
      jobCount: 0,
      confidence: 0,
      aiVerified: false,
    } satisfies VerificationResult)
  }
}
