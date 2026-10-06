// The instance owner. OWNER_USER_ID (an owner step: set it in Vercel and in the environment of
// the scorecard script) marks the one person who may read the scorecard and run owner commands.
// Anyone else, and everyone when it is not set, is not the owner; the route that wraps a command
// answers a non-owner with 404, so the page does not say it exists.

export function isOwner(userId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const owner = env.OWNER_USER_ID?.trim()
  return Boolean(owner) && Boolean(userId) && owner === userId
}
