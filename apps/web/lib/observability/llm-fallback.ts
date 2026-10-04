// One greppable warning when an AI path gives up and its deterministic
// fallback takes over. A 402 (out of credits), a retired model id or a budget
// cap used to vanish into a bare catch, so the product quietly got worse with
// nothing in the logs. Identifiers and the error text only: never a prompt,
// an email or a page body. The message goes through redactString first.

import { redactString } from './scrub'

const MAX_MESSAGE_CHARS = 200

/** Why an LLM call failed: error class, HTTP status when there is one, and a short scrubbed message. */
export function describeLlmFailure(err: unknown): { errorClass: string; status?: number; message: string } {
  const status = (err as { status?: unknown } | null)?.status
  const raw = err instanceof Error ? err.message : String(err)
  return {
    errorClass: err instanceof Error ? err.name || 'Error' : typeof err,
    ...(typeof status === 'number' ? { status } : {}),
    message: redactString(raw).slice(0, MAX_MESSAGE_CHARS),
  }
}

/** `scope` names the feature (e.g. 'gmail-classify'), `fallback` what ran instead. */
export function warnLlmFallback(scope: string, fallback: string, err: unknown): void {
  console.warn(
    `[llm:fallback] ${JSON.stringify({
      at: new Date().toISOString(),
      scope,
      fallback,
      ...describeLlmFailure(err),
    })}`
  )
}
