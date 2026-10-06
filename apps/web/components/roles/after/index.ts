import type { ComponentType } from 'react'
import { ApplicationGroup } from './application'
import { DocumentsGroup } from './documents'
import { MessagesGroup } from './messages'

// The groups of the record after the person has acted (4.6: Application, Documents and Messages). The record
// renders each one above its own groups, in order; a group with nothing to show renders nothing.
export const afterGroups: Array<ComponentType<{ jobId: string }>> = [ApplicationGroup, DocumentsGroup, MessagesGroup]
