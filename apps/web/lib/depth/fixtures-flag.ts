// Fixture pages show made-up data only and never touch Supabase. They are on
// when a build sets CELLO_FIXTURES=1 (Lighthouse in CI, local checks) or on a
// Vercel preview, and 404 everywhere else, production included.

export function fixturesOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.CELLO_FIXTURES === '1' || env.VERCEL_ENV === 'preview'
}
