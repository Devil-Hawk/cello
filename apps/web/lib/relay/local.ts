// A carrier talks to a model on the person's own computer and to nothing else. This
// file has no imports, so the web page and the extension both use this one copy.
// The carrier sends the prompt the server built and returns text. It holds no key,
// no tool and no command.
//
// Only three hostnames count as the person's computer: 127.0.0.1, localhost and [::1].
// A private address (192.168.1.5), a public name (example.com) and a name that merely
// resolves to loopback (127.0.0.1.nip.io) are all refused: a name can be pointed
// anywhere, and a LAN address is some other machine.

export class LoopbackError extends Error {
  constructor(url: string) {
    super(`Not a loopback address: ${url.slice(0, 80)}`)
    this.name = 'LoopbackError'
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function assertLoopback(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LoopbackError(raw)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LoopbackError(raw)
  if (url.username || url.password) throw new LoopbackError(raw)
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new LoopbackError(raw)
  return url
}

export type LocalRuntime = 'ollama' | 'lmstudio'

export interface LocalConfig {
  runtime: LocalRuntime
  baseUrl: string
  model: string
}

export const DEFAULT_BASE: Record<LocalRuntime, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
}

/** The request a carrier runs: the messages the server built and nothing else. */
export interface LocalRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  max_tokens?: number
}

/** Most text a carrier sends back: 64 KB, the limit the table enforces. */
const MAX_RESULT_BYTES = 64 * 1024
const TIMEOUT_MS = 120_000

/** Cut text to at most MAX_RESULT_BYTES of UTF-8 without splitting a character. */
export function clampText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= MAX_RESULT_BYTES) return text
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, MAX_RESULT_BYTES)).replace(/�+$/, '')
}

/**
 * fetch with Chrome's local network hint, so a page asks the person once instead of
 * failing (developer.chrome.com/blog/local-network-access; the value is "local" for
 * loopback too). The extension passes plain fetch instead: its host permission covers loopback.
 */
export const localFetch = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, { ...init, targetAddressSpace: 'local' } as RequestInit)

/** One reply from the local model. Throws a sentence the person can read. */
export async function runLocal(cfg: LocalConfig, req: LocalRequest, doFetch: typeof localFetch = localFetch): Promise<string> {
  const base = assertLoopback(cfg.baseUrl)
  const ollama = cfg.runtime === 'ollama'
  const url = new URL(ollama ? '/api/chat' : '/v1/chat/completions', base).toString()
  const body = ollama
    ? { model: cfg.model, messages: req.messages, stream: false, options: { temperature: req.temperature, num_predict: req.max_tokens } }
    : { model: cfg.model, messages: req.messages, stream: false, temperature: req.temperature, max_tokens: req.max_tokens }

  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error(
      ollama
        ? 'Cello could not reach Ollama on this computer. Check that it is running and allows this page.'
        : 'Cello could not reach LM Studio on this computer. Check that its server is running.',
    )
  }
  if (!res.ok) throw new Error(`The local model answered with an error (${res.status}).`)
  const json = (await res.json().catch(() => null)) as {
    message?: { content?: unknown }
    choices?: Array<{ message?: { content?: unknown } }>
  } | null
  const content = ollama ? json?.message?.content : json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content === '') throw new Error('The local model sent no text.')
  return clampText(content)
}
