// Shared actionable message for "no usable LLM backend" states.
//
// The harness runtime (lib/harness/llm.ts's callLlm) used to call OpenRouter
// ONLY — an OpenAI or Anthropic key saved in Settings did nothing for any AI
// feature. Previously /api/settings/status computed
// hasKey = openrouter||openai||anthropic while every LLM route required
// apiKeys.openrouter specifically, so an openai/anthropic-only account got
// full UI affordances (match buttons, optimizer) and then a bare "missing
// key" 400 on click. This module is the ONE place that turns "no usable
// backend" into a message that explains the actual gap, so
// /api/settings/status, /api/agents/match, /api/agents/match/batch and
// /api/resume/optimize all say the same thing.
//
// Now that the model backend is pluggable (lib/harness/providers/*), "usable"
// depends on which backend is selected: openrouter needs a key; local-cli and
// local-server need self-hosting (isSelfHosted()) plus, for local-server, a
// configured URL. canRunLlm() and missingOpenRouterMessage() both branch on
// keys.provider?.active so every existing call site — none of which pass a
// `provider` field today — keeps its exact current behavior (openrouter-key
// gated) with zero code changes, and only starts reflecting the new backends
// once a caller starts passing provider info through (lib/apikeys.ts and
// lib/harness/keys.ts both do, via getDecryptedApiKeys/loadApiKeys).

import { isSelfHosted, resolveProviderId, type ProviderId } from './providers'

export interface KeyPresence {
  openrouter?: string | null
  openai?: string | null
  anthropic?: string | null
  /** Which backend is selected. Absent/null means 'openrouter' — today's only backend. */
  provider?: { active?: ProviderId | string | null; localServerBaseUrl?: string | null } | null
}

/**
 * True when the account can actually run LLM features RIGHT NOW. Keep this
 * the single definition of "usable" — do not inline `!!keys.openrouter`
 * elsewhere.
 *
 * This checks CONFIGURATION, not live reachability: for local-cli it does
 * not confirm the chosen CLI binary is actually on PATH (that would mean an
 * async filesystem check on every call site that guards on canRunLlm, many
 * of which are hot paths); for local-server it does not probe the URL. Both
 * gaps surface at call time instead, as a clear ProviderUnavailableError from
 * lib/harness/providers/{local-cli,local-server}.ts — exactly the same
 * "necessary but not sufficient" precondition canRunLlm has always checked
 * for openrouter (a present key is not a verified-valid key either).
 */
export function canRunLlm(keys: KeyPresence): boolean {
  const active = resolveProviderId(keys.provider?.active)
  if (active === 'local-cli') return isSelfHosted()
  if (active === 'local-server') return isSelfHosted() && Boolean(keys.provider?.localServerBaseUrl?.trim())
  return Boolean(keys.openrouter && keys.openrouter.trim().length > 0)
}

/** Actionable copy for the 400 body / UI banner when canRunLlm(keys) is false. */
export function missingOpenRouterMessage(keys: KeyPresence): string {
  const active = resolveProviderId(keys.provider?.active)
  const selfHosted = isSelfHosted()

  if (active === 'local-cli') {
    return selfHosted
      ? 'The selected local CLI is not available — install claude, codex, or gemini and sign in with your ' +
          'subscription account, or pick a different provider in Settings → Model.'
      : 'Local CLI providers only work when Cello is self-hosted (they spawn a binary on the machine running ' +
          "Cello) — this instance is running on Vercel. Add an OpenRouter key in Settings → API keys, or point " +
          'Settings → Model at a local server instead.'
  }

  if (active === 'local-server') {
    const url = keys.provider?.localServerBaseUrl?.trim()
    if (!selfHosted) {
      return (
        "Local server providers only work when Cello is self-hosted (they call an address on your own " +
        'network) — this instance is running on Vercel. Add an OpenRouter key in Settings → API keys instead.'
      )
    }
    return url
      ? `Cello can't reach the local server at ${url} — confirm it's running and reachable, or pick a ` +
          'different provider in Settings → Model.'
      : 'No local server URL configured — set one (e.g. http://localhost:11434/v1 for Ollama) in Settings → Model.'
  }

  // active === 'openrouter' — today's original gap, now also listing the
  // other two ways to get an LLM running when this instance can use them.
  const otherOptions = selfHosted
    ? ', point Settings → Model at a local server (Ollama, LM Studio, vLLM), or install and sign in to a CLI ' +
      '(claude, codex, or gemini) and select it in Settings → Model'
    : ', or point Settings → Model at a local server (Ollama, LM Studio, vLLM) reachable from wherever Cello is hosted'

  const hasOpenAi = Boolean(keys.openai)
  const hasAnthropic = Boolean(keys.anthropic)
  if (hasOpenAi || hasAnthropic) {
    const other = hasOpenAi && hasAnthropic ? 'an OpenAI key and an Anthropic key' : hasOpenAi ? 'an OpenAI key' : 'an Anthropic key'
    return (
      `You have ${other} saved, but Cello's default provider routes through OpenRouter — ` +
      `add an OpenRouter key in Settings → API keys${otherOptions}.`
    )
  }
  return `No OpenRouter API key configured — add one in Settings → API keys${otherOptions}.`
}
