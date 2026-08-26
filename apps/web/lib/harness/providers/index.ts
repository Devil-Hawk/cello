// Pluggable LLM provider layer — shared contract + registry.
//
// lib/harness/llm.ts's callLlm() keeps ONE public signature
// (apiKeys, opts, signal?) => Promise<LlmResult> no matter which backend
// actually runs. This module is the shared vocabulary all three backends
// (./openrouter, ./local-cli, ./local-server) and llm.ts itself import: the
// ProviderId union, the per-backend capability flags the UI and llm.ts use to
// degrade quietly instead of erroring, and the two error classes every
// backend throws so existing callers (which only ever imported these from
// lib/harness/llm.ts) keep working unchanged — llm.ts re-exports both.
//
// Deliberately zero Node-runtime imports (no child_process, no fs, no
// 'openai') so this file is safe to `import type` from a 'use client'
// component if a future settings tab wants the ProviderId/ProviderPreferences
// types directly instead of only consuming the /api/settings/providers JSON.

import {
  DEFAULT_PROVIDER_PREFERENCES,
  LOCAL_CLI_IDS,
  PROVIDER_IDS,
  type LocalCliId,
  type ProviderId,
  type ProviderPreferences,
} from '../types'

export { DEFAULT_PROVIDER_PREFERENCES, LOCAL_CLI_IDS, PROVIDER_IDS }
export type { LocalCliId, ProviderId, ProviderPreferences }

/**
 * Thrown when the user hasn't configured a usable backend at all — no
 * OpenRouter key, no provider preference pointing anywhere workable. Kept
 * here (not duplicated per-backend) so every existing `catch (e) { if (e
 * instanceof MissingKeyError) ... }` call site keeps working no matter which
 * backend actually raised it. lib/harness/llm.ts re-exports this class.
 */
export class MissingKeyError extends Error {
  constructor(message = 'No usable LLM provider configured') {
    super(message)
    this.name = 'MissingKeyError'
  }
}

/**
 * Thrown when a *configured* backend can't be reached right now — the local
 * CLI binary isn't on PATH, the local server isn't answering, or the active
 * provider requires self-hosting and this instance is running on Vercel.
 * Distinct from MissingKeyError (nothing configured at all): this is "you
 * pointed Cello at something and it isn't there right now," which callers
 * that only catch MissingKeyError will still see (it's a plain Error) — they
 * just won't special-case it, and its .message is written to be shown as-is.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}

/**
 * The model hit its max_tokens cap, so the content is truncated mid-stream.
 * Only OpenRouter enforces a max_tokens cap the way this models it (local-cli
 * has no such knob; local-server enforces its own max_tokens but callers
 * treat that identically to OpenRouter's). Worth its own type because a
 * truncated JSON body is unrecoverable — parseJsonLoose's greedy regex cannot
 * repair a cut-off object, so without this the user saw a generic "not valid
 * JSON" that reads like a model defect rather than a cap that needs raising.
 */
export class TruncatedResponseError extends Error {
  readonly completionTokens: number
  readonly maxTokens: number
  constructor(completionTokens: number, maxTokens: number) {
    super(
      `Model response was cut off at the ${maxTokens}-token limit ` +
        `(used ${completionTokens}). Retry with a higher maxTokens.`
    )
    this.name = 'TruncatedResponseError'
    this.completionTokens = completionTokens
    this.maxTokens = maxTokens
  }
}

/**
 * What a backend can and cannot honor. llm.ts and callers use these to
 * degrade quietly (drop a request_format, skip a reasoning param) instead of
 * throwing when a call asks for something the active backend can't give.
 */
export interface ProviderCapabilities {
  /** Can request (not necessarily guarantee) a JSON-object response. */
  json: boolean
  /** Honors opts.reasoning — an effort ladder or, for Anthropic, a thinking-token budget. */
  reasoning: boolean
  /** Honors opts.cachePrefix (an explicit prompt-cache breakpoint). */
  cachePrefix: boolean
  /** Honors opts.maxTokens as a hard output cap. */
  maxTokens: boolean
  /** Needs a vendor API key, vs. a local process/socket that needs none. */
  requiresApiKey: boolean
  /** Only reachable when Cello itself runs off Vercel serverless. */
  selfHostedOnly: boolean
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  openrouter: {
    json: true,
    reasoning: true,
    cachePrefix: true,
    maxTokens: true,
    requiresApiKey: true,
    selfHostedOnly: false,
  },
  'local-cli': {
    // The CLIs are coding agents, not a raw chat-completions API: none of
    // them expose a flag that *guarantees* a parseable JSON object back, none
    // take a reasoning-effort param (their thinking, if any, is controlled by
    // the user's own CLI settings/subscription tier, not per-call), none take
    // an explicit cache breakpoint, and none expose an output-token cap.
    json: false,
    reasoning: false,
    cachePrefix: false,
    maxTokens: false,
    requiresApiKey: false,
    selfHostedOnly: true,
  },
  'local-server': {
    // Most OpenAI-compatible local servers (Ollama, LM Studio, vLLM) support
    // response_format:{type:'json_object'} and max_tokens; none standardize a
    // reasoning-effort param or prompt caching.
    json: true,
    reasoning: false,
    cachePrefix: false,
    maxTokens: true,
    requiresApiKey: false,
    selfHostedOnly: true,
  },
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  'local-cli': 'Local CLI (subscription)',
  'local-server': 'Local server',
}

export const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  openrouter:
    'Pay-per-token API key. Works everywhere Cello runs, including Vercel. The only backend that needs a secret.',
  'local-cli':
    "Spawns your own Claude Code, Codex, or Gemini CLI, signed in with your subscription — no API key involved. Only works when Cello is self-hosted: the CLI binary has to be on the machine actually running Cello, so this cannot work on Vercel.",
  'local-server':
    'Any OpenAI-compatible endpoint on your network — Ollama, LM Studio, vLLM. No key required. Only reachable when Cello is self-hosted on the same network as the server.',
}

export const LOCAL_CLI_LABELS: Record<LocalCliId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
}

/** The executable name each local-cli option spawns (PATH-resolved). */
export const LOCAL_CLI_BINARY: Record<LocalCliId, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
}

/** Narrow an arbitrary stored value to a usable ProviderId, else 'openrouter'. */
export function resolveProviderId(id: unknown): ProviderId {
  return typeof id === 'string' && (PROVIDER_IDS as readonly string[]).includes(id)
    ? (id as ProviderId)
    : 'openrouter'
}

/** Narrow an arbitrary stored value to a usable LocalCliId, else 'claude'. */
export function resolveLocalCliId(id: unknown): LocalCliId {
  return typeof id === 'string' && (LOCAL_CLI_IDS as readonly string[]).includes(id)
    ? (id as LocalCliId)
    : 'claude'
}

/** Merge a loosely-typed preferences.provider blob into a full ProviderPreferences. */
export function resolveProviderPreferences(raw: unknown): ProviderPreferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    active: resolveProviderId(r.active),
    localCli: resolveLocalCliId(r.localCli),
    localServerBaseUrl: typeof r.localServerBaseUrl === 'string' ? r.localServerBaseUrl.trim() : '',
    localServerModel: typeof r.localServerModel === 'string' ? r.localServerModel.trim() : '',
    localServerEmbeddingModel:
      typeof r.localServerEmbeddingModel === 'string' ? r.localServerEmbeddingModel.trim() : '',
  }
}

/**
 * True when Cello itself is not running on Vercel serverless — the only
 * environment where spawning a local CLI binary or reaching a localhost
 * server makes sense. Vercel sets VERCEL=1 in every build and runtime
 * environment (both preview and production); its absence is the honest
 * signal this repo has for "self-hosted."
 *
 * process.env access here is fine at RUNTIME (this file has no 'use client'
 * boundary of its own) but this function must never be called from code that
 * ships into a client bundle — see the module comment at the top of this
 * file. Every current caller is a route handler or lib/harness/llm.ts.
 */
export function isSelfHosted(): boolean {
  return !process.env.VERCEL
}

/** Rough token estimate (~4 chars/token), shared by every backend that
 *  doesn't get real usage numbers back from its API/CLI. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
