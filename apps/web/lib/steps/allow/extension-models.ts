// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'lib/kb/retrieve.ts',
    reason: 'Embeds a knowledge-base query; extension-models moves it behind the embed step.',
  },
  {
    file: 'lib/kb/store.ts',
    reason: 'Embeds knowledge-base chunks; extension-models moves it behind the embed step.',
  },
]
