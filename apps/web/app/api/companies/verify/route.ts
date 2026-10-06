import { NextRequest, NextResponse } from 'next/server'
import { withTrace } from '@/lib/trace/spans'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { makeSiteFetcher, ReaderError, type ReaderReason } from '@/lib/ingest/reader/site-fetch'
import { employerNameFromPage, isGenericName, nameFromDomain } from '@/lib/companies/page-name'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { callLlm } from '@/lib/harness/llm'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { warnLlmFallback } from '@/lib/observability/llm-fallback'
import { repostHostOf, repostMessage } from '@/lib/ingest/reader/legit'
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
        name: 'verify-careers-page',
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

  // The employer's name: what the employer declares, else its domain; never a marketing page title.
  const companyName = employerNameFromPage(html, url, domain)

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

/** Why a page could not be read, in words for the add-company dialog. */
const UNREADABLE: Partial<Record<ReaderReason, string>> = {
  robots: "The site's robots.txt asks automated readers to stay away, so Cello will not read it.",
  bot_check: 'The site answers automated requests with a bot check, so Cello cannot read it.',
  login_required: 'The page needs a login, so Cello cannot read it.',
  unreachable: "Cello could not reach this site (its address does not answer), so it cannot read it. Check the address and try again.",
}

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

    // A link on a reposting site (LinkedIn, Indeed, Built In...) is not the employer's careers site: say so, and do not read it.
    const repost = repostHostOf(normalizedUrl)
    if (repost) {
      return NextResponse.json({
        isValid: false,
        status: 'reposting',
        message: `${repostMessage(repost, 'the employer')} Paste the employer's own careers link instead.`,
        companyName: null,
        logoUrl: null,
        jobCount: 0,
        confidence: 0,
        aiVerified: false,
      } satisfies VerificationResult)
    }

    // One plain request as Cello (the user agent names it and its repository), through the same door as every
    // other read of a company's site: public addresses only, every redirect hop checked, robots.txt obeyed.
    // A site that refuses (a bot check, a login, robots.txt) is not asked again under another identity.
    let unreadable: ReaderReason | null = null
    try {
      const res = await makeSiteFetcher({ mode: 'inline' }).get(normalizedUrl)
      if (res.ok) {
        html = res.text
        fetchSuccess = true
      }
    } catch (error) {
      // An SSRF refusal or a timeout is just "unreachable", so the response is no oracle for which it was.
      unreadable = error instanceof ReaderError ? error.reason : 'unreachable'
    }

    if (!fetchSuccess) {
      // Check if URL looks like a career page even without fetching
      // A site Cello cannot reach, or whose robots.txt asks it to stay away, is not "a career page that will be monitored": no green tick.
      const cannotRead = unreadable === 'unreachable' || unreadable === 'robots'
      const urlHasJobPattern = JOB_URL_PATTERNS.some(p => normalizedUrl.toLowerCase().includes(p))
      if (urlHasJobPattern && !cannotRead) {
        const guessedName = lookupKnownCompanyByDomain(domain)?.name ?? nameFromDomain(domain)
        return NextResponse.json({
          isValid: true,
          status: 'unverified',
          message: (unreadable && UNREADABLE[unreadable]) || 'Could not fetch page, but URL looks like a career page. Will monitor.',
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
        message: (unreadable && UNREADABLE[unreadable]) || 'Could not connect to the URL. Please check and try again.',
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
      const llmKeys = apiKeys
      aiAnalysis = await withTrace(
        createAdminClient(),
        requestingUser.id,
        { name: 'verify-careers-page', input: { url: normalizedUrl } },
        () => analyzeWithLlm(llmKeys, html, normalizedUrl)
      )
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
        // A model reading a marketing page can answer with its slogan; the employer's own name wins.
        companyName: aiAnalysis.companyName && !isGenericName(aiAnalysis.companyName) ? aiAnalysis.companyName : employerNameFromPage(html, normalizedUrl, domain),
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
