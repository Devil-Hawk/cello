// An application's project: code's own grouping of that application's chats and made things. Made by code the first
// time a chat starts from the application; no person ever names, lists, pins or opens one (directive 42), and no
// command, route, screen or answer shows the word. This file exports only the two functions that make and join it.

import type { AdminClient } from '@/lib/harness/types'
import { getObject } from './objects'
import type { ObjectReader } from './types'

/** The application's project row, made if it is not there yet. Null when the application is not this person's. */
export async function ensureProject(db: AdminClient, userId: string, applicationId: string, get: ObjectReader = getObject): Promise<string | null> {
  const app = await get(db, userId, 'application', { id: applicationId })
  if (!app) return null
  const title = [app.company, app.title].filter(Boolean).join(': ').slice(0, 80)
  // The unique application_id makes a second call return the first row, so two chats started together share one.
  await db.from('projects').upsert({ user_id: userId, title, kind: 'application', application_id: applicationId, created_by: 'code' }, { onConflict: 'application_id', ignoreDuplicates: true })
  const { data } = await db.from('projects').select('id').eq('application_id', applicationId).eq('user_id', userId).maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/** A chat started from an application joins that application's group, unless it already belongs to one. */
export async function joinApplication(db: AdminClient, userId: string, chatId: string, applicationId: string, get: ObjectReader = getObject): Promise<boolean> {
  const id = await ensureProject(db, userId, applicationId, get)
  if (!id) return false
  const { data } = await db.from('chats').update({ project_id: id }).eq('id', chatId).eq('user_id', userId).is('project_id', null).select('id')
  return ((data as unknown[] | null) ?? []).length === 1
}
