// Where other lanes add to Chat without editing it. Each lane writes its own file in this folder
// and exports the two lists below; this file merges them. Network's file is lib/chat/extend/network.ts.

import type { AdminClient } from '@/lib/harness/types'
import type { ChatObject } from '../types'
import * as network from './network'

/**
 * One thing Chat can offer on an empty chat (chat.suggest). Higher `priority` comes first, one per `kind`,
 * never two about one object, the first three that hold. `text` is at most 40 characters, names from code.
 */
export interface SuggestCandidate {
  kind: string
  text: string
  priority: number
  /** What a tap attaches as tiles. */
  objects?: { kind: string; ref: string }[]
}

/**
 * Adds lines to the screen message for the attached things: for example the memories a person's mail left
 * for an employer. Lines are data: the screen message frames them as quoted, never as instructions.
 */
export type ScreenMessageHook = (db: AdminClient, userId: string, objects: ChatObject[]) => Promise<string[]>

export const suggestCandidates: SuggestCandidate[] = [...network.suggestCandidates]
export const screenMessageHooks: ScreenMessageHook[] = [...network.screenMessageHooks]
