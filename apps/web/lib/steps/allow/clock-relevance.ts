// Raw model calls this lane has not moved behind a step yet. Delete an entry in the
// same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  {
    file: 'lib/ingest/model.ts',
    reason: 'Reads a careers page on the last tier; clock-relevance moves it behind reader.rendered in K5d.',
  },
  {
    file: 'app/api/companies/resolve/route.ts',
    reason: 'Looks up an employer by name; clock-relevance moves it behind companies.resolve_name.',
  },
  {
    file: 'app/api/companies/verify/route.ts',
    reason: 'Reads a board to verify an employer; clock-relevance moves it behind a step with the verifier.',
  },
]
