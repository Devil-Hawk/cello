// Where other lanes add to Chat without editing it. Each lane writes its own file in this folder
// and exports the two lists below; this file merges them. Network's file is lib/chat/extend/network.ts.

import type { AdminClient } from '@/lib/harness/types'
import type { ChatObject } from '../types'
import * as network from './network'

/** One thing Chat can offer on an empty chat. Higher `priority` comes first. */
export interface SuggestCandidate {
  text: string
  priority: number
  /** What the suggestion is about, when it is about one thing. */
  about?: { kind: string; ref: string }
}

/**
 * Adds lines to the screen message for the attached things: for example the memories a person's mail left
 * for an employer. Lines are data: the screen message frames them as quoted, never as instructions.
 */
export type ScreenMessageHook = (db: AdminClient, userId: string, objects: ChatObject[]) => Promise<string[]>

export const suggestCandidates: SuggestCandidate[] = [...network.suggestCandidates]
export const screenMessageHooks: ScreenMessageHook[] = [...network.screenMessageHooks]
