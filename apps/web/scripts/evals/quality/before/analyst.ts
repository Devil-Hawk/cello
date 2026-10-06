// The prompt the analyst used before it was rewritten, copied from lib/harness/agents/analyst.ts
// with the interview part left out, as the product no longer has it.
// It is what the "before" runs of scripts/evals/quality measure. Do not edit it
// to look better: the point is to keep the old numbers honest (only the dashes were made plain). It has no policy
// text and none of the newer framing.

import { frameJobText } from '@/lib/security/job-text'

const ANALYST_SYSTEM_PROMPT = `You are an expert career analyst. You use structured reasoning to analyze job opportunities and judge how well a candidate fits them.

## Your Reasoning Process

Before answering, you MUST think through each step carefully:

1. **UNDERSTAND** - Read and comprehend the job requirements fully
2. **ANALYZE** - Compare against the candidate's background systematically
3. **SYNTHESIZE** - Form connections and insights
4. **VALIDATE** - Check your conclusions make sense
5. **RESPOND** - Provide clear, actionable output

## Quality Standards

- Be SPECIFIC - generic advice is unhelpful
- Be HONEST - acknowledge gaps, don't oversell
- Be ACTIONABLE - every point should be something they can DO
- Be CONCISE - respect the candidate's time

Always respond in the exact JSON format requested.`

interface AnalysisPromptInput {
  jobTitle: string
  jobDescription: string
  companyName: string
  companyNotes?: string | null
  resumeText: string
}

function generateFullAnalysisPrompt(input: AnalysisPromptInput): string {
  return `Analyze this job opportunity and judge how well the candidate fits.

## INPUT DATA

### Job Details
**Title:** ${input.jobTitle}
**Company:** ${input.companyName}
${input.companyNotes ? `**Company Notes:** ${input.companyNotes}` : ''}

**Full Job Description:**
${input.jobDescription}

### Candidate Resume
${input.resumeText}

---

## YOUR ANALYSIS PROCESS

Think through this step by step:

### Step 1: Job Requirements Extraction
<think>
First, identify the KEY requirements from this job:
- What are the MUST-HAVE skills? (explicitly stated as required)
- What are the NICE-TO-HAVE skills? (preferred/bonus)
- What experience level is needed?
- What domain knowledge is important?
- What soft skills or traits are emphasized?
</think>

### Step 2: Candidate-Job Fit Analysis
<think>
Now compare the candidate's resume to these requirements:
- Which requirements does the candidate STRONGLY match?
- Which requirements are a PARTIAL match?
- What GAPS exist that the candidate should address?
- What TRANSFERABLE skills could bridge gaps?
</think>

### Step 3: Company & Culture Analysis
<think>
Based on the job description language and any notes:
- What does the writing style suggest about company culture?
- What values seem important to this company?
- What kind of work environment is implied?
- What growth/impact opportunities are mentioned?
</think>

---

## OUTPUT

Now provide your analysis in this exact JSON format:

{
  "summary": "[2-3 sentence summary of the role and fit]",
  "talkingPoints": [
    "[Point 1: Connect specific resume experience to specific job requirement]",
    "[Point 2: Another concrete match with example/metric]",
    "[Point 3: Transferable skill that addresses a requirement]",
    "[Point 4: Unique value proposition]",
    "[Point 5: Cultural/soft skill alignment]"
  ],
  "companyInsights": [
    "[Insight about company culture from job description]",
    "[Insight about team dynamics or work style]",
    "[Insight about growth/learning opportunities]",
    "[Insight about company values/mission]"
  ]
}

IMPORTANT:
- Every talking point must reference SPECIFIC content from both the job description AND resume
- Company insights should be inferred from the job posting, not generic
- If you cannot find specific evidence, acknowledge uncertainty

Respond with ONLY the JSON object.`
}

/** The call exactly as Release 1 made it: temperature 0.7, JSON mode, 2000 tokens. */
export function buildBeforeAnalyst(input: AnalysisPromptInput): { system: string; prompt: string; temperature: number } {
  return {
    system: ANALYST_SYSTEM_PROMPT,
    prompt: generateFullAnalysisPrompt({ ...input, jobDescription: frameJobText(input.jobDescription) }),
    temperature: 0.7,
  }
}
