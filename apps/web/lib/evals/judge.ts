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
//   still only ONE provider and ONE key here — see meteredJudgeClient below.
//
//   Not going through callLlm does NOT mean going untraced: the same fetch
//   wrapper below also emits one 'llm' span per request (same attributes as
//   callLlm's) and warns on a non-2xx response, so judge calls appear in
//   trace_spans and a 402 or retired model id is visible in the logs.
//
// WHY THE PER-CALL `client` OPTION AND NOT AUTOEVALS' GLOBAL `init()`
//   `init()` stashes the client on `globalThis`, so two tests judging with
//   different keys (or running in parallel) would race on which client wins.
//   Every autoevals scorer also accepts `client` directly per call — see
//   node_modules/autoevals/jsdist/index.js's buildOpenAIClient, which checks
//   `options.client` before ever touching the global — so passing it
//   explicitly here avoids the shared mutable state entirely.
//
// WHY meteredJudgeClient METERS VIA A `fetch` WRAPPER AND NOT A SEPARATE CALL
//   autoevals hands its scorer's HTTP request straight to `client.chat.
//   completions.create` — there is no per-call hook to inject a budget check
//   around, only the OpenAI SDK's own `fetch` constructor option (which every
//   request already goes through). Wrapping THAT is the one seam that sees
//   every request this client ever makes, so reserveSpend/settleSpend
//   live there instead of at judgeGroundedness/judgeSpecificity's call sites
//   (see lib/evals/judge.test.ts for the ordering proof: reserve before the
//   real fetch, settle after the response).
//
// COST
//   Judge model is `anthropic/claude-haiku-4.5` — the cheapest model in
//   lib/models.ts's ALLOWED_MODELS ($1/$5 per M in/out tokens, see
//   lib/harness/spend.ts's PRICES), and already a model this codebase trusts
//   for high-volume work. A judge call is one short classification prompt
//   (a few hundred tokens), so this is cents even run often — but it is still
//   real spend against the user's OpenRouter key, which is why
//   judged.eval.test.ts gates every call behind RUN_JUDGE_EVALS.

import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'
import { ClosedQA, Factuality } from 'autoevals'
import { MissingKeyError } from '../harness/llm'
import {
  actualCostUsd,
  estimateCostDetails,
  estimateCostUsd,
  estimatePromptTokens,
  reserveSpend,
  rungFor,
  settleSpend,
} from '../harness/spend'
import { logHarnessError } from '../observability/log'
import { warnLlmFallback } from '../observability/llm-fallback'
import { acquireSpanScope, withSpan } from '../trace/spans'
import type { AdminClient, DecryptedApiKeys } from '../harness/types'
import type { EvalResult, EvalVerdict } from './harness'

// Mirrors lib/harness/providers/openrouter.ts exactly (base URL + headers) —
// this IS the OpenRouter path, not a second one.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const HEADERS = {
  'HTTP-Referer': 'https://cello.app',
  'X-Title': 'Cello - Job Search Assistant',
}

/** Which judge call is running, and (written back by meteredFetch) the span
 *  its request became. Per call, not per client: the outreach route runs two
 *  judges concurrently on one client, and an AsyncLocalStorage slot follows
 *  each call's own async chain. */
interface JudgeSlot {
  /** Langfuse generation name, e.g. `judge-groundedness`. */
  name: string
  spanId?: string
}
const judgeSlot = new AsyncLocalStorage<JudgeSlot>()

/** Run one autoevals scorer under its Langfuse name and report the span id of
 *  its request. */
async function runJudge<T>(name: string, fn: () => T | Promise<T>): Promise<{ value: T; spanId?: string }> {
  const slot: JudgeSlot = { name }
  const value = await judgeSlot.run(slot, async () => fn())
  return { value, spanId: slot.spanId }
}

/** See the COST comment above for why this model and not the product default. */
export const JUDGE_MODEL = 'anthropic/claude-haiku-4.5'

// ponytail: OpenRouter's chat/completions response carries `usage` on every
// call observed against JUDGE_MODEL, so the wrapper below reads real prompt/
// completion counts from it. This pair is the fallback for the one case that
// isn't under our control — a response that omits `usage` — and is not a
// guess: it's the same deliberately-high estimate this route used for BOTH
// judge calls combined before this wrapper existed (see the git history of
// app/api/outreach/judge/route.ts), halved per call. Under-counting spend is
// the failure that costs the user money (spend.ts's own PRICES fallback
// makes the identical trade for an unrecognised model), so this stays high
// rather than accurate-looking. Tighten only if this path is ever observed
// to actually fire.
const JUDGE_FALLBACK_PROMPT_TOKENS = 2000
const JUDGE_FALLBACK_COMPLETION_TOKENS = 300

// ponytail: autoevals sets max_tokens on its OWN outgoing request per scorer/
// model (observed as high as 64000 against Factuality) — nothing in this app
// configures it. A judge grading a short draft has no business demanding two
// orders of magnitude more completion tokens than the draft itself, and that
// gap is exactly what turned one judge call into an uncaught 402 (see
// outreach.ts's verify catch for the other half of that fix). Clamp is fixed,
// not per-model tuned; raise the ceiling if a judge prompt genuinely needs
// more headroom.
const JUDGE_MAX_TOKENS_CEILING = 2000

/** Bound an outgoing judge request's `max_tokens` to JUDGE_MAX_TOKENS_CEILING:
 *  clamp a larger value and SET one when the request carries none, because the
 *  spend reservation is priced from it (a request with no ceiling would reserve,
 *  and could spend, the model's full output window).
 *  `init.body` is always a JSON string here — the OpenAI SDK builds it via
 *  `JSON.stringify(body)` before ever calling `fetch` (see openai/internal/
 *  request-options.js) — so a parse failure means this wasn't a chat request
 *  body at all, and the request goes out untouched. */
function clampJudgeMaxTokens(init: RequestInit | undefined): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init
  let body: { max_tokens?: number }
  try {
    body = JSON.parse(init.body) as { max_tokens?: number }
  } catch {
    return init
  }
  if (typeof body.max_tokens === 'number' && body.max_tokens <= JUDGE_MAX_TOKENS_CEILING) return init
  return { ...init, body: JSON.stringify({ ...body, max_tokens: JUDGE_MAX_TOKENS_CEILING }) }
}

/**
 * Wrap the global `fetch` with the same two guards every other model path
 * gets: reserve BEFORE the request (a request already sent cannot be
 * refunded), settle AFTER the response, parsing real usage and cost off the
 * body. Scoped to one (admin, userId) pair per client — see
 * meteredJudgeClient below, which is the only thing that constructs this.
 *
 * MUTATION CHECK (executed, not left to trust): commented out the
 * `settleSpend(admin, reservation, {...})` call below:
 * lib/evals/judge.test.ts's "reserves before the request and settles real
 * usage..." and "meters both calls (2 reservations, 2 settles)..." tests
 * both went red (`expected [...] to deeply equal [...]`, `expected "spy" to
 * be called 2 times, but got 0 times`). Reverted immediately; `git diff`
 * confirmed a byte-identical file.
 */
function meteredFetch(
  admin: AdminClient,
  userId: string
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const clamped = clampJudgeMaxTokens(init)
    const requestedModel = requestedModelOf(clamped)
    // One 'llm' span per request, same shape callLlm emits, so judge calls show
    // up in trace_spans (and the Langfuse mirror) next to every other model call.
    const scope = acquireSpanScope(userId)
    // Reserve the worst case BEFORE the request (a request already sent cannot be
    // refunded): the whole body as the prompt estimate, plus the max_tokens ceiling.
    const sentBody = typeof clamped?.body === 'string' ? clamped.body : ''
    const reservation = await reserveSpend(admin, {
      userId,
      model: requestedModel,
      promptTokens: estimatePromptTokens(sentBody, requestMessagesOf(clamped)?.length ?? 1),
      maxTokens: JUDGE_MAX_TOKENS_CEILING,
      rung: rungFor('openrouter', requestedModel),
      step: 'judge',
      traceId: scope.buffer.traceId,
    })

    const slot = judgeSlot.getStore()
    let used: { model: string; promptTokens: number; completionTokens: number; costUsd?: number; text?: string } | undefined
    try {
      return await withSpan(
        scope.buffer,
        { parentSpanId: scope.parentSpanId, runId: scope.runId, kind: 'llm', name: 'llm' },
        async (spanId) => {
          if (slot && spanId) slot.spanId = spanId
          const response = await fetch(input, clamped)
          // Thrown (not returned) so the span is marked 'error'; the catch
          // below hands the same response back to the OpenAI SDK untouched.
          if (!response.ok) {
            // The provider answered with an error and generated nothing.
            await settleSpend(admin, reservation, { failed: { status: response.status } })
            throw await JudgeHttpError.from(response)
          }
          used = await readUsage(response)
          await settleSpend(admin, reservation, {
            model: used.model,
            promptTokens: used.promptTokens,
            completionTokens: used.completionTokens,
            costUsd: used.costUsd,
          })
          return response
        },
        (response, err) =>
          response && used
            ? {
                model: used.model,
                promptTokens: used.promptTokens,
                completionTokens: used.completionTokens,
                tokensUsed: used.promptTokens + used.completionTokens,
                costUsd: used.costUsd ?? estimateCostUsd(used.model, used.promptTokens, used.completionTokens),
                metered: true,
                userId,
                source: 'judge',
              }
            : {
                model: requestedModel,
                metered: true,
                userId,
                source: 'judge',
                error: err instanceof Error ? err.message : String(err),
              },
        // A judge request is a Langfuse generation (usage and cost live only
        // on generations), named after the judge. Verdict scores attach to it.
        (response, _err, capture) => ({
          name: slot?.name ?? 'judge-call',
          type: 'generation',
          model: used?.model ?? requestedModel,
          modelParameters: requestParamsOf(clamped),
          metadata: { source: 'judge', metered: true },
          ...(used
            ? {
                usage: { input: used.promptTokens, output: used.completionTokens, total: used.promptTokens + used.completionTokens },
                cost:
                  used.costUsd !== undefined
                    ? { total: used.costUsd }
                    : estimateCostDetails(used.model, used.promptTokens, used.completionTokens),
              }
            : {}),
          ...(capture
            ? {
                input: requestMessagesOf(clamped),
                ...(response && used?.text !== undefined ? { output: { role: 'assistant', content: used.text } } : {}),
              }
            : {}),
        })
      )
    } catch (err) {
      if (err instanceof JudgeHttpError) {
        // A 402 or a retired model id must be visible, not just a null score.
        warnLlmFallback('judge', 'verdict-unavailable', err)
        return err.response
      }
      throw err
    } finally {
      // Only the call that created the buffer flushes it; inside a graph
      // invocation the graph root does.
      if (scope.owns) await scope.buffer.flush(admin)
    }
  }
}

/** A non-2xx judge response, carrying the Response so the SDK still sees it. */
class JudgeHttpError extends Error {
  readonly status: number
  constructor(
    readonly response: Response,
    detail: string
  ) {
    super(`judge request failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
    this.name = 'JudgeHttpError'
    this.status = response.status
  }

  static async from(response: Response): Promise<JudgeHttpError> {
    // Peek at a clone for the provider's own reason ("Insufficient credits").
    const detail = await response
      .clone()
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => '')
    return new JudgeHttpError(response, detail)
  }
}

/** The chat messages of an outgoing judge request, for the Langfuse input
 *  (capture on only; langfuse.ts redacts and caps them). */
function requestMessagesOf(init: RequestInit | undefined): { role: string; content: string }[] | undefined {
  if (typeof init?.body !== 'string') return undefined
  try {
    const messages = (JSON.parse(init.body) as { messages?: unknown }).messages
    if (!Array.isArray(messages)) return undefined
    return messages
      .filter((m): m is { role: string; content: unknown } => typeof (m as { role?: unknown })?.role === 'string')
      .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
  } catch {
    return undefined
  }
}

function requestedModelOf(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') return JUDGE_MODEL
  try {
    const model = (JSON.parse(init.body) as { model?: unknown }).model
    return typeof model === 'string' && model ? model : JUDGE_MODEL
  } catch {
    return JUDGE_MODEL
  }
}

/** The sampling parameters the judge request actually carried (after the
 *  max_tokens clamp), for the Langfuse generation. */
function requestParamsOf(init: RequestInit | undefined): Record<string, number> {
  if (typeof init?.body !== 'string') return {}
  try {
    const body = JSON.parse(init.body) as { temperature?: unknown; max_tokens?: unknown }
    return {
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    }
  } catch {
    return {}
  }
}

/** Real usage off the body (response.clone() so the SDK can still read it), or
 *  the deliberately high fallback when the body has none. */
async function readUsage(
  response: Response
): Promise<{ model: string; promptTokens: number; completionTokens: number; costUsd?: number; text?: string }> {
  try {
    const body = (await response.clone().json()) as {
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
      choices?: { message?: { content?: unknown; tool_calls?: { function?: { arguments?: unknown } }[] } }[]
    }
    const usage = body.usage
    // autoevals asks for a forced tool call, so the judge's answer and reasons
    // are the call's arguments, not message content.
    const message = body.choices?.[0]?.message
    const toolArgs = message?.tool_calls?.[0]?.function?.arguments
    const text = typeof message?.content === 'string' ? message.content : typeof toolArgs === 'string' ? toolArgs : undefined
    if (typeof usage?.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      return {
        model: body.model ?? JUDGE_MODEL,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        costUsd: actualCostUsd(usage),
        text,
      }
    }
  } catch {
    // Body wasn't JSON: same conservative fallback as a missing `usage` field.
  }
  return {
    model: JUDGE_MODEL,
    promptTokens: JUDGE_FALLBACK_PROMPT_TOKENS,
    completionTokens: JUDGE_FALLBACK_COMPLETION_TOKENS,
  }
}

/**
 * Build the OpenAI-compatible client autoevals' scorers expect, using the
 * user's OWN OpenRouter key (apiKeys.openrouter) — never a second credential
 * — with every request it makes billed against `userId`'s monthly cap via
 * `meteredFetch` above, exactly like callLlm's own OpenRouter path.
 * `userId` is required (not optional) so a call site cannot construct this
 * client without something to meter against — see spend-chokepoints.test.ts's
 * CALL_LLM_WRAPPERS entry for the source-level pin.
 *
 * Throws MissingKeyError (the same class every other callLlm caller already
 * catches) when apiKeys.openrouter isn't configured.
 */
export function meteredJudgeClient(
  admin: AdminClient,
  userId: string,
  apiKeys: Pick<DecryptedApiKeys, 'openrouter'>
): OpenAI {
  const key = apiKeys.openrouter
  if (!key) throw new MissingKeyError('No OpenRouter API key configured — cannot run a judged eval')
  return new OpenAI({
    apiKey: key,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: HEADERS,
    fetch: meteredFetch(admin, userId),
  })
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
export function toEvalResult(name: string, judged: JudgeScore, threshold: number, userId?: string, spanId?: string): EvalResult {
  // autoevals returns score: null when the judge call itself failed to parse
  // a usable answer (see OpenAIClassifier's parseResponse) — that is a judge
  // failure, not a verdict on the draft, so it gets the harness's existing
  // "refuse rather than report noise" treatment. It is ALSO the exact silent-
  // failure shape logHarnessError exists to close (see that module's header):
  // without this, a judge quietly producing garbage forever would surface
  // nowhere an operator looks. `name` stands in for stepLabel/runId — a judge
  // call has neither a harness step nor an agent_runs row behind it, just a
  // stable identifier ("outreach groundedness"/"outreach specificity").
  if (judged.score === null) {
    logHarnessError(
      { runId: name, stepLabel: name, agentType: 'judge', phase: 'judge', userId },
      new Error('Judge produced no usable score')
    )
    return {
      name,
      verdict: 'insufficient-data',
      score: null,
      threshold,
      n: 1,
      summary: `Judge produced no usable score — treat as inconclusive, not as a pass.`,
      ...(spanId ? { spanId } : {}),
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
    ...(spanId ? { spanId } : {}),
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
 * `userId` is optional — judged.eval.test.ts's direct calls have no signed-in
 * user behind them — but a caller with one (the outreach route) should pass
 * it so a score:null failure attributes to someone in the log line.
 */
export interface JudgeCallOpts {
  model?: string
  threshold?: number
  userId?: string
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
  opts: JudgeCallOpts = {}
): Promise<EvalResult> {
  const { value: result, spanId } = await runJudge('judge-groundedness', () =>
    Factuality({
      input:
        "Does the submitted outreach draft rely only on facts present in the candidate's resume " +
        "and the job's stated facts, without asserting anything beyond them?",
      output: input.draft,
      expected: input.sourceFacts,
      client,
      model: opts.model ?? JUDGE_MODEL,
    })
  )
  return toEvalResult('outreach groundedness', result, opts.threshold ?? 0.5, opts.userId, spanId)
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
export interface MatchQualityInput {
  /** The matcher verdict's own summary + strengths/gaps — what it claims. */
  verdictSummary: string
  /** The job + resume facts the verdict was scored against. */
  jobAndResume: string
}

/**
 * Is a SAMPLED match verdict's stated summary/strengths/gaps internally
 * consistent with the job and resume it was scored against, or does it read
 * like a fabricated / self-contradictory assessment? Step 4, item 3's
 * "judge (ClosedQA rubric check) on a SAMPLE" — built on ClosedQA for the
 * same reason judgeSpecificity is: this is a yes/no rubric check against one
 * written criterion, not a reference-answer diff.
 */
export async function judgeMatchQuality(
  client: OpenAI,
  input: MatchQualityInput,
  opts: JudgeCallOpts = {}
): Promise<EvalResult> {
  const { value: result, spanId } = await runJudge('judge-match-quality', () =>
    ClosedQA({
      input: 'Is this match assessment consistent with the job and resume it claims to be scored against?',
      output: input.verdictSummary,
      criteria:
        'Every strength, gap and the overall score is plausibly supported by the job and resume facts given, ' +
        'with nothing that contradicts them or reads as invented.',
      client,
      model: opts.model ?? JUDGE_MODEL,
    })
  )
  return toEvalResult('match quality', result, opts.threshold ?? 0.6, opts.userId, spanId)
}

export async function judgeSpecificity(
  client: OpenAI,
  input: SpecificityInput,
  opts: JudgeCallOpts = {}
): Promise<EvalResult> {
  const { value: result, spanId } = await runJudge('judge-specificity', () =>
    ClosedQA({
      input: 'Is this outreach message specific to the named company and role, rather than generic boilerplate?',
      output: input.draft,
      criteria:
        `The message references a concrete, verifiable detail about ${input.companyAndRole} — a named ` +
        'product, team, technology, or fact drawn from the job post — rather than only generic ' +
        'enthusiasm that would read the same pasted into an outreach message for a different company.',
      client,
      model: opts.model ?? JUDGE_MODEL,
    })
  )
  return toEvalResult('outreach specificity', result, opts.threshold ?? 0.6, opts.userId, spanId)
}
