// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'lib/harness/agents/company_researcher.ts',
    reason: 'Company research loop; chat moves it behind research.summary in K24b.',
  },
  {
    file: 'lib/harness/agents/resume_optimizer.ts',
    reason: 'Resume optimizer; replaced by documents.draft in K17.',
  },
  {
    file: 'lib/harness/planner.ts',
    reason: 'The run planner; chat retires it in K24a.',
  },
  {
    file: 'lib/evals/judge.ts',
    reason: 'The eval judge builds its own client; chat moves it onto the factory in K24b.',
  },
]
