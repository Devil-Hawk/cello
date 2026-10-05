/**
 * The page to land on after sign-in, from the ?next= param, but only when it
 * is a path on THIS site. Anything that could leave the origin (an absolute
 * URL, a protocol-relative //host, a backslash that some browsers read as a
 * slash, a tab or newline the URL parser silently strips to make "/\t/host"
 * into "//host") falls back to the dashboard, so the auth callback is not an
 * open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/dashboard'
  if (next.includes('\\') || /[\u0000-\u001f\u007f]/.test(next)) return '/dashboard'
  return next
}
