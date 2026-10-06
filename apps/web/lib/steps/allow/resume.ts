// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'app/api/resume/upload/route.ts',
    reason: 'Reformats an imported resume with callLlm; resume moves it behind the Writer. The photo read is the resume.photo step.',
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
