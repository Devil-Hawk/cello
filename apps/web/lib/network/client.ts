// The browser side of a command door (lib/network/door.ts).

/** The browser side: run a command through its door and return the body, or throw the sentence the server gave. */
export async function callCommand<T = unknown>(path: string, command: string, input: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, input }) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not do that.')
  return body as T
}
