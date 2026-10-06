// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'scripts/mutation-check-scans.ts',
    reason: 'Holds the scanner patterns as string fixtures. The one permanent entry, named in the strict rule.',
    permanent: true,
  },
]
