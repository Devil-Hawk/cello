import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'

// The groups of the record after the person has acted (4.6: Application, Documents and Messages). The record
// renders each one above its own groups, in order; a group with nothing to show renders nothing. Each loads after
// the page, so the record's first load stays as small as it was (the bundle check holds it).
const ApplicationGroup = dynamic(() => import('./application').then((m) => m.ApplicationGroup), { ssr: false })
const DocumentsGroup = dynamic(() => import('./documents').then((m) => m.DocumentsGroup), { ssr: false })
const MessagesGroup = dynamic(() => import('./messages').then((m) => m.MessagesGroup), { ssr: false })

export const afterGroups: Array<ComponentType<{ jobId: string }>> = [ApplicationGroup, DocumentsGroup, MessagesGroup]
