// Local CLI provider — spawns the user's OWN authenticated Claude Code /
// Codex / Gemini CLI and talks to it over stdin/stdout.
//
// WHY THIS EXISTS: a ChatGPT Plus/Pro or Claude Pro/Max subscription does NOT
// grant REST API access — the chat app and the API are separately billed
// products, and there is no key to paste for either. What the subscription
// DOES buy is the vendor's own CLI, authenticated against the subscription
// account, which runs programmatically on the user's machine. That CLI
// binary is the sanctioned interface here — this file spawns it and reads
// its stdout. It NEVER reads, copies, or reuses the CLI's own OAuth
// tokens/credential store to call the vendor API directly; that would
// violate the CLI's terms and risk the user's account.
//
// ONLY WORKS SELF-HOSTED: Vercel serverless has no binaries and no PATH
// worth spawning against. Every entry point here checks isSelfHosted() and
// throws a ProviderUnavailableError with that reasoning spelled out, rather
// than failing in some more confusing way mid-request.
//
// CAPABILITY HONESTY: none of the three CLIs expose a flag that *guarantees*
// a parseable JSON object back, a reasoning-effort knob, prompt-cache
// breakpoints, or an output-token cap — see PROVIDER_CAPABILITIES['local-cli']
// in ./index. When opts.json is set we ask nicely (append an instruction to
// the prompt) but do not pretend to guarantee it; callers already run
// parseJsonLoose on the result, same as they tolerate today's occasional
// imperfect OpenRouter output.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path'
import type { DecryptedApiKeys, LlmResult, LlmRunOptions } from '../types'
import {
  LOCAL_CLI_BINARY,
  LOCAL_CLI_IDS,
  LOCAL_CLI_LABELS,
  ProviderUnavailableError,
  estimateTokens,
  isSelfHosted,
  resolveLocalCliId,
  type LocalCliId,
} from './index'

/** Per-call wall-clock budget. These are full coding-agent CLIs with
 *  plugin/hook/MCP startup overhead on top of the actual model call, so this
 *  is generous compared to a raw API timeout. */
const CALL_TIMEOUT_MS = 180_000

export interface LocalCliAvailability {
  id: LocalCliId
  label: string
  binary: string
  /** True only when self-hosted AND the binary resolves on PATH. */
  available: boolean
  /** Human-readable reason when available is false. */
  reason?: string
  /** Absolute path to the resolved binary, when found. */
  path?: string
}

/**
 * Resolve `bin` against PATH the same way a shell's `which` would, without
 * spawning a process just to ask. Returns the absolute path when found, else
 * null. POSIX-only (Cello's self-hosted target is Linux/macOS) — Windows
 * PATHEXT resolution is not implemented.
 */
async function resolveOnPath(bin: string): Promise<string | null> {
  const pathEnv = process.env.PATH || ''
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue
    const candidate = pathJoin(dir, bin)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Not in this directory — keep looking.
    }
  }
  return null
}

/** Detect whether one local CLI is actually usable on this machine right now. */
export async function detectLocalCli(id: LocalCliId): Promise<LocalCliAvailability> {
  const binary = LOCAL_CLI_BINARY[id]
  const label = LOCAL_CLI_LABELS[id]
  if (!isSelfHosted()) {
    return {
      id,
      label,
      binary,
      available: false,
      reason: 'Requires self-hosting — this Cello instance is running on Vercel serverless, which has no CLI binaries.',
    }
  }
  const path = await resolveOnPath(binary)
  if (!path) {
    return { id, label, binary, available: false, reason: `'${binary}' was not found on PATH.` }
  }
  return { id, label, binary, available: true, path }
}

/** Detect every local CLI option at once — used by GET /api/settings/providers. */
export async function detectAllLocalClis(): Promise<LocalCliAvailability[]> {
  return Promise.all(LOCAL_CLI_IDS.map((id) => detectLocalCli(id)))
}

/**
 * Flatten a chat-style call into a single text transcript for a CLI's stdin.
 * None of the three CLIs expose a stable system+multi-turn-messages protocol
 * over stdin, so this degrades to a plain transcript — good enough for the
 * single-shot generation calls callLlm is used for.
 */
function buildStdinPrompt(opts: LlmRunOptions): string {
  const parts: string[] = []
  if (opts.system) parts.push(`System instructions:\n${opts.system}`)
  if (opts.messages && opts.messages.length > 0) {
    for (const m of opts.messages) {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User'
      parts.push(`${role}: ${m.content}`)
    }
  } else if (opts.prompt) {
    parts.push(opts.prompt)
  }
  if (opts.json) {
    parts.push(
      'Respond with ONLY a single valid JSON object or array — no prose, no markdown code fences, ' +
        'no explanation before or after it. (Best-effort request: this CLI backend cannot guarantee JSON mode.)'
    )
  }
  return parts.join('\n\n')
}

interface CliInvocation {
  args: string[]
  /** When set, the CLI writes its final message here — read this instead of
   *  stdout (stdout carries noisy human-formatted progress for some CLIs). */
  outFile?: string
}

/** Args to invoke each CLI non-interactively, reading the prompt from stdin. */
function prepareInvocation(id: LocalCliId): CliInvocation {
  switch (id) {
    case 'claude':
      // -p/--print with no positional prompt reads the prompt from stdin;
      // "print mode" also skips the workspace-trust dialog that would
      // otherwise hang a non-interactive spawn with no TTY to answer it.
      return { args: ['-p', '--output-format', 'text'] }
    case 'codex': {
      // `codex exec -` reads instructions from stdin explicitly.
      // --sandbox read-only: this is a text-completion call, not an
      // invitation to let a coding agent write to the host filesystem.
      // -o <file>: write ONLY the final message to a file instead of having
      // to parse it back out of the human-formatted progress on stdout.
      const outFile = pathJoin(tmpdir(), `cello-codex-${randomUUID()}.txt`)
      return {
        args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-o', outFile, '-'],
        outFile,
      }
    }
    case 'gemini':
      return { args: ['--output-format', 'text'] }
  }
}

function spawnAndCollect(
  binPath: string,
  args: string[],
  stdinText: string,
  signal: AbortSignal | undefined
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      timeout: CALL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // Run from a neutral cwd, not wherever the Cello server process
      // happens to live — this is a generic text-completion call, not an
      // invitation to explore/edit Cello's own repo, and it keeps the CLI
      // from picking up Cello's own project-level CLAUDE.md/config.
      cwd: tmpdir(),
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8')
    })

    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolve({ stdout, stderr, code }))

    // Writing after the child has already exited (e.g. it errored out fast)
    // throws EPIPE on the stdin stream — the 'close' handler above still
    // fires with the real failure, so just swallow this one.
    child.stdin?.on('error', () => {})
    child.stdin?.write(stdinText, 'utf8')
    child.stdin?.end()
  })
}

/**
 * Spawn the user's own subscription CLI (claude / codex / gemini) with the
 * full prompt on stdin and return its final text output.
 *
 * Never passes prompt content or secrets as argv — everything goes over
 * stdin, both to dodge ARG_MAX on long prompts and so the prompt never shows
 * up in `ps aux` on the host. Honors AbortSignal (kills the subprocess via
 * Node's built-in spawn signal option) and a fixed per-call wall-clock
 * timeout. Does NOT honor opts.maxTokens, opts.temperature, opts.reasoning,
 * or opts.cachePrefix — see PROVIDER_CAPABILITIES['local-cli'] in ./index,
 * which callers should check before assuming any of those apply.
 */
export async function callLocalCli(
  apiKeys: DecryptedApiKeys,
  opts: LlmRunOptions,
  signal?: AbortSignal
): Promise<LlmResult> {
  if (!isSelfHosted()) {
    throw new ProviderUnavailableError(
      'Local CLI providers only work when Cello is self-hosted (they spawn a binary on the machine ' +
        'running Cello) — this instance is running on Vercel serverless. Switch to OpenRouter or a ' +
        'local server in Settings → Model.'
    )
  }

  const id = resolveLocalCliId(apiKeys.provider?.localCli)
  const availability = await detectLocalCli(id)
  if (!availability.available || !availability.path) {
    throw new ProviderUnavailableError(
      `${LOCAL_CLI_LABELS[id]} ('${LOCAL_CLI_BINARY[id]}') is not available: ${availability.reason || 'not found on PATH'}. ` +
        `Install it and sign in with your subscription account, or pick a different provider in Settings → Model.`
    )
  }

  const stdinText = buildStdinPrompt(opts)
  const { args, outFile } = prepareInvocation(id)

  let result: { stdout: string; stderr: string; code: number | null }
  try {
    result = await spawnAndCollect(availability.path, args, stdinText, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ProviderUnavailableError(`Failed to run ${LOCAL_CLI_LABELS[id]}: ${message}`)
  }

  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exited with code ${result.code}`).slice(0, 500)
    if (outFile) await unlink(outFile).catch(() => {})
    throw new ProviderUnavailableError(`${LOCAL_CLI_LABELS[id]} exited with an error: ${detail}`)
  }

  let content = result.stdout.trim()
  if (outFile) {
    try {
      const fromFile = (await readFile(outFile, 'utf8')).trim()
      if (fromFile) content = fromFile
    } catch {
      // Fall back to stdout — the CLI may not have written the file (e.g. it
      // errored after producing partial stdout but before the final write).
    } finally {
      await unlink(outFile).catch(() => {})
    }
  }

  const promptTokens = estimateTokens(stdinText)
  const completionTokens = estimateTokens(content)

  return {
    content,
    tokensUsed: promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    model: `local-cli/${id}`,
    finishReason: 'stop',
  }
}
