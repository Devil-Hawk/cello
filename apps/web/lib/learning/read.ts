// The one-read path (blueprint 9, agents-v3 5.1). Every ranking, pick, prepare order or
// draft run reads the learnings once, with one filtered getAll: no embedding call, no
// model, one query, held for that run only. Code then applies each learning's `params`
// by its `effect`.
//
// If mem0 or its direct connection is unavailable, or slow, the run proceeds without
// learnings and the page says so in one line. Nothing waits on mem0 and nothing guesses.

import { getMemoryStore } from '../memory/mem0-store'
import type { MemoryStore } from '../memory/types'
import { formatKeptBlock } from './store'
import { LEARNING_SCOPE, toLearning, type Learning, type LearningStatus } from './types'

export const LEARNINGS_UNAVAILABLE = 'Cello could not read what it learned. Roles are in their usual order.'

/** How long a run waits for mem0 before it goes on without. */
export const READ_TIMEOUT_MS = 3000

export type LearningsRead = { ok: true; items: Learning[] } | { ok: false; sentence: string }

/** `any` reads every status (the morning run needs to know a learning was turned off). */
export async function readLearnings(userId: string, status: LearningStatus | 'any' = 'active', store: MemoryStore = getMemoryStore()): Promise<LearningsRead> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const items = await Promise.race([
      store.getAll(userId, { filters: { scope: LEARNING_SCOPE, ...(status === 'any' ? {} : { status }) } }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('reading learnings timed out')), READ_TIMEOUT_MS)
      }),
    ])
    return { ok: true, items: items.map(toLearning).filter((l): l is Learning => l !== null) }
  } catch (err) {
    console.error('[learning] could not read learnings:', err instanceof Error ? err.message : err)
    return { ok: false, sentence: LEARNINGS_UNAVAILABLE }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The kept-statements block for a prompt, '' when there is none or mem0 cannot be read. */
export async function keptLearningsBlock(userId: string, store?: MemoryStore): Promise<string> {
  const read = await readLearnings(userId, 'active', store)
  return read.ok ? formatKeptBlock(read.items) : ''
}

/** The key of the learning that lets reactions order roles. */
export const TASTE_KEY = 'taste:blend'

/**
 * Whether the person's reactions and past applications may order their roles this run. On
 * unless the person turned `taste:blend` off. When mem0 cannot be read the run uses the
 * code order, and says so.
 */
export function tasteFrom(read: LearningsRead): { taste: boolean; note: string | null } {
  if (!read.ok) return { taste: false, note: read.sentence }
  const blend = read.items.find((l) => l.key === TASTE_KEY)
  return { taste: blend?.status !== 'off', note: null }
}
