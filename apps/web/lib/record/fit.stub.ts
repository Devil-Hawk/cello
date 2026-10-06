// lane-stub: PG3 fit
// Until K17b (learning-writer) is on main this reads each requirement of the posting as unknown: no
// verdict is made and no evidence is shown, and it does not claim that anything was looked for (that is
// `notFound`, a fact about where code looked). The shape is learning-writer's lib/fit/types.ts; this
// file defines none. Deleted at integration step 17, when the record reads K17b's `roles.get`.

import type { FitItem, RoleFitView } from '@/lib/fit/types'
import type { RequirementItem } from '@/lib/jobs/relevance-types'

export function readFit(items: readonly RequirementItem[]): RoleFitView {
  const read: FitItem[] = items.map((r) => ({ requirementId: r.id, requirement: r.text, verdict: 'unknown', evidence: [], origin: 'code' }))
  return { items: read, strip: { strengths: 0, gaps: 0, unknown: read.length }, needsModel: false, readAt: null }
}
