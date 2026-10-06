// lane-stub: PG2 needs-you
// Until K20's list (lib/needs-you) is on main this reads nothing: it returns no rows, so Today shows no
// Needs you section and never claims that nothing needs the person. The fixtures and tests build rows
// with `fixtureNeedsYou` (components/today/fixtures.ts), typed by lib/needs-you/types.ts. Deleted at
// integration step 14, when the section reads the real list.

import type { NeedsYouRow } from '@/lib/needs-you/types'

export async function readNeedsYou(): Promise<NeedsYouRow[]> {
  return []
}
