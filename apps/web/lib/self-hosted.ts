// The one answer to "may this process spawn local commands or reach local
// servers": stdio MCP servers and the local-cli / local-server providers all
// gate on it, so they cannot drift apart.
//
// Explicit opt-in, default off. The old heuristic was "VERCEL is unset", which
// is also true of any other host, where a signed-in user could then store an
// arbitrary command and have the server run it. VERCEL stays a hard veto: it is
// set in every Vercel build and runtime, so a stray CELLO_SELF_HOSTED=1 there
// still cannot turn this on.
//
// Server-side only: never call this from code that ships in a client bundle.
export function isSelfHosted(): boolean {
  return !process.env.VERCEL && process.env.CELLO_SELF_HOSTED === '1'
}
