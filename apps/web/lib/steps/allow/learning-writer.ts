// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'lib/insights/store.ts',
    reason: 'Embeds insights; learning-writer moves it behind the embed step in K15.',
  },
  {
    file: 'lib/memory/mem0-store.ts',
    reason: 'The memory store embeds and extracts; learning-writer moves it behind steps in K15.',
  },
]
