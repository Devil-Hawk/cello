// What the page needs to talk to the stream route with LangGraph's useStream hook.
//
//   const transport = new FetchStreamTransport({ apiUrl: AGENT_STREAM_URL, fetch: agentFetch })
//   useStream({ transport, ... })
//
// The hook's transport turns a failed request into `Failed to stream: ${response.statusText}`.
// Over HTTP/2 (every Vercel response) statusText is empty, and the sentence the route sent in
// the body would be lost. agentFetch puts that sentence into statusText, and errorMessage reads
// it back out, so the person sees "Add an OpenRouter key in Settings..." and not a status code.
//
// This file is for the browser: it imports nothing from the server side.

export const AGENT_STREAM_URL = '/api/agent/stream'

const FALLBACK = 'Something went wrong on our side. Your conversation is saved; send your message again.'
const PREFIX = 'Failed to stream: '

/** fetch, but a refusal keeps the route's own sentence in statusText. */
export async function agentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.ok) return response
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null
  const message = typeof body?.message === 'string' && body.message.trim() ? body.message.replace(/[\r\n]+/g, ' ').trim() : FALLBACK
  return new Response(response.body, { status: response.status, statusText: message, headers: response.headers })
}

/** The sentence to show for an error from the hook, or from a failed fetch. Never a status code or a stack. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const sentence = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : ''
  return sentence.trim() || FALLBACK
}
