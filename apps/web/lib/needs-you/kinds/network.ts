// Network's rows: one per person due a follow-up on the follow-up rule (4.9a). Code over contact_touch.
// K20's kind for these is `nudge`; the row id keeps the blueprint's name, follow_up_person.

import type { NeedsYouKindSource } from '../types'
import { dueNudges } from '@/lib/network/nudges'

export const kinds: NeedsYouKindSource[] = [
  {
    kinds: ['nudge'],
    async load({ client, userId, now }) {
      const due = await dueNudges(client, userId, now)
      return due.map((d) => ({
        id: `follow_up_person:${d.contactId}`,
        kind: 'nudge' as const,
        group: 'follow_up' as const,
        target: { kind: 'person' as const, id: d.contactId },
        companyId: null,
        companyName: d.employer ?? d.agency,
        logoUrl: null,
        roleTitle: d.tie?.roleTitle ?? null,
        sentence: `Follow up with ${d.name}${d.employer ? ` at ${d.employer}` : ''}. ${d.fact}`,
        dueAt: d.dueAt,
        button: { label: 'Review follow-up', command: 'network.nudges', args: { contactId: d.contactId } },
        count: 1,
        members: [],
      }))
    },
  },
]
