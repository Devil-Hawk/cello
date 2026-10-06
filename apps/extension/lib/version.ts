/** Compare dotted numeric versions. Negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** True when the build is older than the server's minimum. */
export function needsUpdate(current: string, minimum: string | undefined): boolean {
  return !!minimum && compareVersions(current, minimum) < 0
}
