// Harness runtime — planner. Turns a natural-language goal into a validated DAG
// of agent steps ({ label, agent_type, input, dependsOn[] }).
//
// The planner asks the user's OpenRouter model for a JSON DAG, validates it with
// PlanSchema (unique labels, resolvable deps, no self-cycles), and retries once
// on invalid JSON/shape. If there is no key, or the model keeps producing an
// invalid plan, it falls back to a deterministic default pipeline so a run can
// always proceed.

import { callLlm, parseJsonLoose, MissingKeyError } from './llm'
import { AGENT_CATALOG, EXECUTABLE_AGENT_TYPES } from './registry'
import { PlanSchema } from './schemas'
import type { DecryptedApiKeys, Plan } from './types'
import { composeSystemPrompt, loadModeDoc } from './prompts'

export interface PlanResult {
  plan: Plan
  tokensUsed: number
  /** true when the deterministic fallback was used instead of the LLM. */
  fallback: boolean
}

const MAX_PLAN_ATTEMPTS = 2

function catalogText(): string {
  return EXECUTABLE_AGENT_TYPES.map((t) => `- ${t}: ${AGENT_CATALOG[t]}`).join('\n')
}

/**
 * System prompt = _shared.md + prompts/planner.md (the house-style mode
 * document — see docs/PROMPT-GENERATOR.md; `_voice.md` is deliberately
 * excluded, since a planner never emits human-facing prose) + the agent
 * catalog. The catalog is identical for every planning call, every user,
 * forever (it comes from the static registry, not per-user data), so it is
 * passed as `stableContext` and the whole system message is a cache hit from
 * the 2nd call on.
 */
function systemPrompt(): string {
  return composeSystemPrompt({
    mode: loadModeDoc('planner'),
    includeVoice: false,
    stableContext: `AVAILABLE AGENT TYPES (use ONLY these, never invent one):\n${catalogText()}`,
  })
}

/** Deterministic fallback: source new jobs, score them, enrich the top matches. */
export function defaultPlan(goal: string): Plan {
  return PlanSchema.parse({
    goal,
    steps: [
      { label: 'source-jobs', agent_type: 'sourcer', input: {}, dependsOn: [] },
      { label: 'score-jobs', agent_type: 'matcher', input: {}, dependsOn: ['source-jobs'] },
      { label: 'enrich-top', agent_type: 'enricher', input: {}, dependsOn: ['score-jobs'] },
    ],
  })
}

export async function planGoal(
  goal: string,
  apiKeys: DecryptedApiKeys,
  signal?: AbortSignal
): Promise<PlanResult> {
  if (!apiKeys.openrouter) {
    return { plan: defaultPlan(goal), tokensUsed: 0, fallback: true }
  }

  let tokensUsed = 0
  let lastError = ''

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    try {
      const userPrompt =
        attempt === 1
          ? `Goal: ${goal}`
          : `Goal: ${goal}\n\nYour previous plan was invalid: ${lastError}. Return a corrected JSON plan.`

      const res = await callLlm(
        apiKeys,
        {
          system: systemPrompt(),
          prompt: userPrompt,
          json: true,
          // Raised from 1200: reasoning tokens below bill as output and share
          // this cap with the plan JSON itself, so a typical 6-step plan
          // (~400-600 tokens) plus a medium reasoning pass needs real headroom.
          maxTokens: 2000,
          temperature: 0.2,
          // Choosing the DAG shape is a judgement call (which steps, in what
          // order, how minimal) — worth the reasoning spend.
          reasoning: { effort: 'medium' },
          // The catalog + rules are a fixed string for every plan, every user,
          // forever — the cheapest possible cache prefix to mark.
          cachePrefix: true,
        },
        signal
      )
      tokensUsed += res.tokensUsed

      const raw = parseJsonLoose(res.content)
      const parsed = PlanSchema.safeParse(raw)
      if (parsed.success) {
        return { plan: parsed.data, tokensUsed, fallback: false }
      }
      lastError = parsed.error.issues.map((i) => i.message).join('; ')
    } catch (err) {
      if (err instanceof MissingKeyError) break
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  // Could not get a valid plan from the model — proceed with the safe default.
  console.warn(`[harness] planner falling back to default plan: ${lastError}`)
  return { plan: defaultPlan(goal), tokensUsed, fallback: true }
}
