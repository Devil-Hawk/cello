// Single source of truth for the selectable LLM model ids.
//
// This lives in lib/ (not in app/api/settings/model/route.ts) because Next.js
// App Router route modules may ONLY export the HTTP verb handlers plus a fixed
// set of route segment config keys. Any extra export (`export const
// ALLOWED_MODELS`) fails `next build` with a route-type error that `tsc
// --noEmit` cannot see. Same bug class as commit 3de749a (getDecryptedApiKeys).
//
// Consumers: app/api/settings/model/route.ts (validation),
// components/settings/model-tab.tsx (UI), lib/harness/llm.ts (fallback).

/** Selectable model ids — verified-existing OpenRouter ids. */
export const ALLOWED_MODELS = [
  'anthropic/claude-sonnet-5',
  'moonshotai/kimi-k3',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.2',
  'moonshotai/kimi-k2-thinking',
  'anthropic/claude-haiku-4.5',
] as const

/** Union of the allowed OpenRouter model ids. */
export type ModelId = (typeof ALLOWED_MODELS)[number]

/** Used whenever the user has not picked a model. */
export const DEFAULT_MODEL_ID: ModelId = 'anthropic/claude-sonnet-5'

export interface ModelInfo {
  id: ModelId
  /** Short display name for the settings UI. */
  label: string
  /** One-line blurb shown under the label. */
  description: string
  /** Rough cost band, for sorting/badging in the UI. */
  tier: 'flagship' | 'balanced' | 'fast' | 'value'
}

/** Display metadata for every allowed model, in UI presentation order. */
export const MODELS: readonly ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Balanced quality and speed — recommended default',
    tier: 'balanced',
  },
  {
    id: 'anthropic/claude-opus-4.8',
    label: 'Claude Opus 4.8',
    description: 'Maximum quality for the hardest reasoning',
    tier: 'flagship',
  },
  {
    id: 'openai/gpt-5.2',
    label: 'GPT-5.2',
    description: 'OpenAI flagship — strong general reasoning',
    tier: 'flagship',
  },
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    description: '1M context with reasoning — best for scoring many jobs at once',
    tier: 'flagship',
  },
  {
    id: 'moonshotai/kimi-k2-thinking',
    label: 'Kimi K2 Thinking',
    description: 'Open model with reasoning — low cost',
    tier: 'value',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    description: 'Cheap and fast for high-volume runs',
    tier: 'fast',
  },
] as const

/** True when `id` is one of the allowed model ids. */
export function isAllowedModel(id: unknown): id is ModelId {
  return typeof id === 'string' && (ALLOWED_MODELS as readonly string[]).includes(id)
}

/** Display metadata for a model id, or undefined when it is not allowed. */
export function getModelInfo(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id)
}

/** Narrow an arbitrary stored value to a usable model id, else DEFAULT_MODEL_ID. */
export function resolveModelId(id: unknown): ModelId {
  return isAllowedModel(id) ? id : DEFAULT_MODEL_ID
}
