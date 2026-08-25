// LLM-as-judge — a thin wrapper over `autoevals`, for the Cello outputs a
// programmatic scorer cannot check because there is no ground truth to diff
// against.
//
// WHY THIS EXISTS
//   The match scorer (see match-scorer.eval.test.ts) has behavioural labels —
//   did the user apply? — so it's judged by ranking, for free, forever. The
//   outreach draft has no such signal: it goes to a named human under the
//   user's name, and "is this actually about THIS company, or would it read
//   fine pasted into any cover letter" is a judgement call, not a computation.
//   That is exactly the gap an LLM judge fills, and exactly why it must not
//   run unattended — see judged.eval.test.ts for the opt-in gate.
//
// WHY THIS CALLS OPENROUTER DIRECTLY AND NOT `callLlm`
//   `callLlm` (lib/harness/llm.ts) is the metered, budget-checked, retried
//   path every AGENT uses, and it returns Cello's own LlmResult shape.
//   autoevals' scorers (Factuality, ClosedQA, ...) don't call an injectable
//   function — they take an OpenAI-COMPATIBLE CLIENT and place their own tool
//   -calling chat completion request through it. Reusing callLlm would mean
//   either forking autoevals' internals or wrapping callLlm behind a fake
//   `chat.completions.create`, which is more indirection than just building
//   the same client callOpenRouter already builds (same base URL, same
//   headers, same user key) and handing it straight to autoevals. There is
//   still only ONE provider and ONE key here — see buildJudgeClient below.
//
// WHY THE PER-CALL `client` OPTION AND NOT AUTOEVALS' GLOBAL `init()`
//   `init()` stashes the client on `globalThis`, so two tests judging with
//   different keys (or running in parallel) would race on which client wins.
//   Every autoevals scorer also accepts `client` directly per call — see
//   node_modules/autoevals/jsdist/index.js's buildOpenAIClient, which checks
//   `options.client` before ever touching the global — so passing it
//   explicitly here avoids the shared mutable state entirely.
//
// COST
//   Judge model is `anthropic/claude-haiku-4.5` — the cheapest model in
//   lib/models.ts's ALLOWED_MODELS ($1/$5 per M in/out tokens, see
//   lib/harness/spend.ts's PRICES), and already a model this codebase trusts
//   for high-volume work. A judge call is one short classification prompt
//   (a few hundred tokens), so this is cents even run often — but it is still
//   real spend against the user's OpenRouter key, which is why
//   judged.eval.test.ts gates every call behind RUN_JUDGE_EVALS.

import OpenAI from 'openai'
import { ClosedQA, Factuality } from 'autoevals'
import { MissingKeyError } from '../harness/llm'
import type { DecryptedApiKeys } from '../harness/types'
import type { EvalResult, EvalVerdict } from './harness'

// Mirrors lib/harness/providers/openrouter.ts exactly (base URL + headers) —
// this IS the OpenRouter path, not a second one.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const HEADERS = {
  'HTTP-Referer': 'https://cello.app',
  'X-Title': 'Cello - Job Search Assistant',
}

/** See the COST comment above for why this model and not the product default. */
export const JUDGE_MODEL = 'anthropic/claude-haiku-4.5'

/**
 * Build the OpenAI-compatible client autoevals' scorers expect, using the
 * user's OWN OpenRouter key (apiKeys.openrouter) — never a second credential.
 * Throws MissingKeyError (the same class every other callLlm caller already
 * catches) when that key isn't configured.
 */
export function buildJudgeClient(apiKeys: Pick<DecryptedApiKeys, 'openrouter'>): OpenAI {
  const key = apiKeys.openrouter
  if (!key) throw new MissingKeyError('No OpenRouter API key configured — cannot run a judged eval')
  return new OpenAI({ apiKey: key, baseURL: OPENROUTER_BASE_URL, defaultHeaders: HEADERS })
}

/** Score in autoevals' native 0-1 range, before being wrapped as an EvalResult. */
interface JudgeScore {
  score: number | null
  metadata?: Record<string, unknown>
}

/**
 * Wrap an autoevals Score in the harness's own EvalResult so a judged eval
 * reports through the exact same shape (and the exact same
 * formatEvalResult()) as a free, deterministic one — a reader of eval output
 * should not need to know which kind produced a given line.
 */
function toEvalResult(name: string, judged: JudgeScore, threshold: number): EvalResult {
  // autoevals returns score: null when the judge call itself failed to parse
  // a usable answer (see OpenAIClassifier's parseResponse) — that is a judge
  // failure, not a verdict on the draft, so it gets the harness's existing
  // "refuse rather than report noise" treatment.
  if (judged.score === null) {
    return {
      name,
      verdict: 'insufficient-data',
      score: null,
      threshold,
      n: 1,
      summary: `Judge produced no usable score — treat as inconclusive, not as a pass.`,
    }
  }

  const verdict: EvalVerdict = judged.score >= threshold ? 'pass' : 'fail'
  const rationale = typeof judged.metadata?.rationale === 'string' ? judged.metadata.rationale : undefined
  const scored = `scored ${judged.score.toFixed(2)} (threshold ${threshold})`
  return {
    name,
    verdict,
    score: judged.score,
    threshold,
    n: 1,
    summary:
      verdict === 'pass'
        ? `${scored}.${rationale ? ` ${rationale}` : ''}`
        : `${scored} — below threshold.${rationale ? ` ${rationale}` : ''}`,
  }
}

export interface GroundednessInput {
  /** The outreach draft under judgement. */
  draft: string
  /**
   * The resume facts + job facts the draft is ALLOWED to draw on — the
   * "expert answer" Factuality diffs the draft against. Anything the draft
   * asserts beyond this is what groundedness is checking for.
   */
  sourceFacts: string
}

/**
 * Does the draft assert anything not supported by the candidate's resume and
 * the job's stated facts? Built on autoevals' Factuality, which classifies a
 * submission against an "expert answer" as a subset / superset / exact match
 * / outright disagreement (see templates/factuality.yaml) and scores each
 * bucket 0-1.
 *
 * CAVEAT: Factuality's "superset, but still consistent" bucket (an assertion
 * the source doesn't confirm but doesn't contradict either) scores 0.6, not
 * 0 — it was built for QA correctness, not hallucination detection, so an
 * invented detail that doesn't happen to conflict with anything in
 * `sourceFacts` can still score respectably. It reliably catches an
 * assertion that CONTRADICTS the source (scored 0) — see
 * judged.eval.test.ts's ordering assertion, which relies on relative score,
 * not just the pass/fail line, for exactly this reason.
 */
export async function judgeGroundedness(
  client: OpenAI,
  input: GroundednessInput,
  opts: { model?: string; threshold?: number } = {}
): Promise<EvalResult> {
  const result = await Factuality({
    input:
      "Does the submitted outreach draft rely only on facts present in the candidate's resume " +
      "and the job's stated facts, without asserting anything beyond them?",
    output: input.draft,
    expected: input.sourceFacts,
    client,
    model: opts.model ?? JUDGE_MODEL,
  })
  return toEvalResult('outreach groundedness', result, opts.threshold ?? 0.5)
}

export interface SpecificityInput {
  /** The outreach draft under judgement. */
  draft: string
  /** What "specific to this" means here, e.g. "Acme Corp, Senior Backend Engineer". */
  companyAndRole: string
}

/**
 * Is this outreach message about THIS company and role, or interchangeable
 * boilerplate that could be pasted into any cover letter? Built on autoevals'
 * ClosedQA, which is a yes/no criterion check rather than Factuality's
 * five-way comparison — specificity isn't "does this match a reference
 * answer", it's "does this message satisfy one written rule", which is what
 * ClosedQA is for.
 */
export async function judgeSpecificity(
  client: OpenAI,
  input: SpecificityInput,
  opts: { model?: string; threshold?: number } = {}
): Promise<EvalResult> {
  const result = await ClosedQA({
    input: 'Is this outreach message specific to the named company and role, rather than generic boilerplate?',
    output: input.draft,
    criteria:
      `The message references a concrete, verifiable detail about ${input.companyAndRole} — a named ` +
      'product, team, technology, or fact drawn from the job post — rather than only generic ' +
      'enthusiasm that would read the same pasted into an outreach message for a different company.',
    client,
    model: opts.model ?? JUDGE_MODEL,
  })
  return toEvalResult('outreach specificity', result, opts.threshold ?? 0.6)
}
