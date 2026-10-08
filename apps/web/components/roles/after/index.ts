import type { ComponentType } from 'react'
import { ApplicationGroup, DocumentsGroup, MessagesGroup } from './lazy'

// The groups of the record after the person has acted (4.6: Application, Documents and Messages). The record
// renders each one above its own groups, in order; a group with nothing to show renders nothing. They load
// after the page (lazy.tsx).
export const afterGroups: Array<ComponentType<{ jobId: string }>> = [ApplicationGroup, DocumentsGroup, MessagesGroup]
