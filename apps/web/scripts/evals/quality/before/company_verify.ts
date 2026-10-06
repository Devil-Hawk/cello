// Release 1 prompt, copied from app/api/companies/verify/route.ts.
// It is what the "before" runs of scripts/evals/quality measure. Do not edit it
// to look better: the point is to keep the old numbers honest (only the dashes were made plain). It has no policy
// text and none of the newer framing.

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

/** The call exactly as Release 1 made it: the page text goes in plain, after the URL. */
export function buildBeforeVerify(url: string, pageText: string): { system: string; prompt: string } {
  return { system: VERIFY_SYSTEM_PROMPT, prompt: `URL: ${url}\n\nPage content:\n${pageText}` }
}
