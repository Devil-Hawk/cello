'use client'

// Each group loads after the page, so the record's first load stays as small as it was (the bundle check holds
// it). The record is a server component: a dynamic import called there still lands in its first load, so the
// imports are made here, in a client module.
import dynamic from 'next/dynamic'

export const ApplicationGroup = dynamic(() => import('./application').then((m) => m.ApplicationGroup), { ssr: false })
export const DocumentsGroup = dynamic(() => import('./documents').then((m) => m.DocumentsGroup), { ssr: false })
export const MessagesGroup = dynamic(() => import('./messages').then((m) => m.MessagesGroup), { ssr: false })
