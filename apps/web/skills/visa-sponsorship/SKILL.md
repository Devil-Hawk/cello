---
name: visa-sponsorship
description: "Say what a company's own careers text states about visa sponsorship or work authorization. Use when the person asks whether a company sponsors visas (H-1B, work permits) or whether they can apply without authorization. Reports only what the text says; unknown is the default."
---

# Visa sponsorship

Use this when the person's situation depends on whether a company sponsors. A wrong confident answer here can cost them an application that was never viable, or stop them applying where they would have been sponsored.

## Procedure

1. Get the company's own careers or jobs page text: read the page with the researcher or from the role's posting. Use no other text for this answer.
2. Look for a statement about sponsorship or work authorization. Quote it exactly.
3. Classify what it literally says:
   - **Sponsors**: the text says the company sponsors visas or will for this role.
   - **Does not sponsor**: the text says it does not, or that applicants must already be authorized to work.
   - **Unknown**: the text says nothing, or hedges ("considered case by case").
4. Report the class and the quote.

## Output

- One of `sponsors`, `does not sponsor`, `unknown`.
- The exact quote, in quotation marks, and where it was found. For `unknown`, say the text does not address it.
- One sentence on what the person could do next, for example asking a recruiter.

## Rules

- Report only what the text literally says. Do not infer from company size, industry, prestige or how other companies behave. A slick careers page proves nothing.
- A hedge is `unknown`, never `likely` or `unlikely`. Do not round an ambiguous statement up to a definite one.
- Never write a quote that is not an excerpt of the text you read.
- If a public list of past sponsors is supplied by a tool, say it is a weaker signal than the company's own statement, and keep it separate.
- This is not legal advice. Say so in one short sentence when the person is deciding something important on it.
