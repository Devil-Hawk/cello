// LLM Prompts for Analyst Agent
// Uses Chain of Thought (CoT) reasoning for more accurate analysis

import type { AnalysisInput } from './types'

/**
 * System prompt for the analyst role with meta-reasoning instructions
 */
export const ANALYST_SYSTEM_PROMPT = `You are an expert career analyst and interview coach. You use structured reasoning to analyze job opportunities and provide actionable preparation guidance.

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

/**
 * Generate the full analysis prompt with chain of thought reasoning
 */
export function generateFullAnalysisPrompt(input: AnalysisInput): string {
  return `Analyze this job opportunity and provide interview preparation guidance.

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

### Step 4: Interview Strategy Formulation
<think>
Given the fit analysis:
- What stories/examples should the candidate prepare?
- What technical topics need review?
- What behavioral questions are likely?
- What questions should the candidate ask?
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
  ],
  "interviewTips": [
    "[Specific technical topic to review with why]",
    "[Behavioral question to prepare with STAR format example topic]",
    "[Question to ask the interviewer that shows insight]",
    "[Preparation activity: research, practice, etc.]",
    "[Mindset or approach tip for this specific role/company]"
  ]
}

IMPORTANT:
- Every talking point must reference SPECIFIC content from both the job description AND resume
- Company insights should be inferred from the job posting, not generic
- Interview tips should be tailored to THIS role, not generic interview advice
- If you cannot find specific evidence, acknowledge uncertainty

Respond with ONLY the JSON object.`
}

/**
 * Generate a job summary prompt with reasoning
 */
export function generateJobSummaryPrompt(
  jobTitle: string,
  jobDescription: string,
  companyName: string
): string {
  return `Summarize this job posting in 2-3 sentences.

**Job:** ${jobTitle} at ${companyName}

**Description:**
${jobDescription}

---

<think>
Before summarizing, identify:
1. The PRIMARY purpose of this role (what problem does it solve?)
2. The KEY responsibilities (what will they DO day-to-day?)
3. The CORE requirements (what's non-negotiable?)
4. The TEAM context (who will they work with?)
</think>

Now write a concise 2-3 sentence summary that captures:
- What the role IS (not just the title)
- What makes it INTERESTING or IMPORTANT
- What the IDEAL candidate brings

Provide ONLY the summary, no additional text.`
}

/**
 * Generate talking points prompt with reasoning
 */
export function generateTalkingPointsPrompt(
  jobDescription: string,
  resumeText: string
): string {
  return `Generate 3-5 interview talking points that connect this candidate to this job.

**Job Description:**
${jobDescription}

**Candidate Resume:**
${resumeText}

---

## Reasoning Process

<think>
Step 1: Extract the top 5-7 requirements from the job description.
For each requirement, note if it's explicitly required or preferred.

Step 2: For each requirement, search the resume for:
- Direct matches (same skill/technology mentioned)
- Indirect matches (similar skill, related experience)
- Quantifiable achievements that demonstrate the skill

Step 3: Prioritize talking points by:
- Strength of match (direct > indirect > transferable)
- Importance to job (required > preferred > nice-to-have)
- Uniqueness (what makes this candidate stand out?)

Step 4: For each talking point, structure it as:
"I have [experience/skill] which directly applies to [requirement], as demonstrated when I [specific achievement/example]"
</think>

---

Respond with a JSON array of 3-5 talking points:
["talking point 1", "talking point 2", "talking point 3"]

Each point must:
- Name a SPECIFIC skill/experience from the resume
- Connect to a SPECIFIC requirement from the job
- Include a CONCRETE example or metric when possible`
}

/**
 * Generate company insights prompt with reasoning
 */
export function generateCompanyInsightsPrompt(
  companyName: string,
  jobDescription: string,
  companyNotes?: string | null
): string {
  return `Provide insights about ${companyName}'s culture and work environment based on this job posting.

**Job Description:**
${jobDescription}

${companyNotes ? `**Additional Notes:**\n${companyNotes}` : ''}

---

## Reasoning Process

<think>
Analyze the job description as a WINDOW into the company:

1. LANGUAGE ANALYSIS
   - Is the tone formal or casual? (indicates company culture)
   - Are there buzzwords? What do they reveal?
   - How do they describe the team? (collaborative, autonomous, etc.)

2. VALUES SIGNALS
   - What do they emphasize beyond skills?
   - What benefits/perks are highlighted?
   - What does "success in this role" look like to them?

3. WORK STYLE INDICATORS
   - Remote/hybrid/onsite expectations?
   - Fast-paced vs. methodical language?
   - Startup energy vs. enterprise stability?

4. GROWTH SIGNALS
   - What learning opportunities are mentioned?
   - Is there career path language?
   - What impact could this role have?
</think>

---

Respond with a JSON array of 3-5 insights:
["insight 1", "insight 2", "insight 3"]

Each insight should:
- Be INFERRED from the job description, not assumed
- Be USEFUL for interview preparation
- Help the candidate understand what the company REALLY values`
}

/**
 * Generate interview tips prompt with reasoning
 */
export function generateInterviewTipsPrompt(
  jobTitle: string,
  jobDescription: string,
  companyName: string
): string {
  return `Generate specific interview preparation tips for a ${jobTitle} position at ${companyName}.

**Job Description:**
${jobDescription}

---

## Reasoning Process

<think>
1. TECHNICAL PREPARATION
   - What technologies/tools are mentioned?
   - What depth of knowledge is implied? (basic usage vs. deep expertise)
   - What technical challenges might this role face?

2. BEHAVIORAL PREPARATION
   - What soft skills are emphasized?
   - What team dynamics are described?
   - Map these to likely STAR-format questions

3. COMPANY RESEARCH
   - What should the candidate learn about ${companyName}?
   - What recent news/products might be relevant?
   - What questions would show genuine interest?

4. PRACTICAL LOGISTICS
   - What interview format is likely? (phone, technical, panel)
   - What should they prepare to demonstrate?
   - How should they present themselves?
</think>

---

Respond with a JSON array of 3-5 tips:
["tip 1", "tip 2", "tip 3"]

Each tip should:
- Be SPECIFIC to this role and company
- Be ACTIONABLE (something they can DO before the interview)
- Include the WHY (why this matters for this specific role)`
}
