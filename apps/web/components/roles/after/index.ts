import type { ComponentType } from 'react'

// The groups of the record after the person has acted (4.6: Application,
// Documents and Messages). Empty until the pages that own them ship; the record
// renders each one above its own groups, in order.
export const afterGroups: Array<ComponentType<{ jobId: string }>> = []
