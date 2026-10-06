// release/1 outreach judges frozen for the "before" measurement: autoevals
// Factuality (groundedness) and ClosedQA (specificity), pointed at a free
// OpenRouter model through an OpenAI-compatible client. Not used by the app.

import OpenAI from 'openai'
import { ClosedQA, Factuality } from 'autoevals'
import { loadKey } from '../lib/free-model'

function client(): OpenAI {
  return new OpenAI({ apiKey: loadKey() ?? 'none', baseURL: 'https://openrouter.ai/api/v1' })
}

/** Factuality's own scoring: a "superset but consistent" claim scores 0.6, so 0.5 passed it. */
export async function legacyGroundedness(model: string, draft: string, sourceFacts: string): Promise<{ pass: boolean; score: number | null }> {
  const r = await Factuality({
    input: "Does the submitted outreach draft rely only on facts present in the candidate's resume and the job's stated facts, without asserting anything beyond them?",
    output: draft,
    expected: sourceFacts,
    client: client(),
    model,
  })
  return { pass: r.score !== null && r.score >= 0.5, score: r.score }
}

/** ClosedQA with only "Company, Title" to go on, as release/1 called it. */
export async function legacySpecificity(model: string, draft: string, companyAndRole: string): Promise<{ pass: boolean; score: number | null }> {
  const r = await ClosedQA({
    input: 'Is this outreach message specific to the named company and role, rather than generic boilerplate?',
    output: draft,
    criteria:
      `The message references a concrete, verifiable detail about ${companyAndRole} — a named ` +
      'product, team, technology, or fact drawn from the job post — rather than only generic ' +
      'enthusiasm that would read the same pasted into an outreach message for a different company.',
    client: client(),
    model,
  })
  return { pass: r.score !== null && r.score >= 0.6, score: r.score }
}
