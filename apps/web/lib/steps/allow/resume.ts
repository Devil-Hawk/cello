// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'app/api/resume/upload/route.ts',
    reason: 'Reads a resume photo with Claude or OpenAI; K14 moves it behind resume.photo.',
  },
  {
    file: 'app/api/resume/documents/route.ts',
    reason: 'Generates a resume document; resume moves it behind the Writer.',
  },
  {
    file: 'app/api/resume/optimize/route.ts',
    reason: 'Optimizes a resume; resume moves it behind the Writer.',
  },
]
