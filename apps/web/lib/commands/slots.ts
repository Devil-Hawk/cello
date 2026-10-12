// The count behind every limit: one atomic call to take_command_slot (migration
// 20261010000000). A refusal to count is a refusal to run: a limit that cannot be
// checked is not a limit.

import type { AdminClient } from '@/lib/harness/types'

export interface SlotRequest {
  userId: string
  /** The door's name. */
  channel: string
  bucket: string
  limit: number
  windowSeconds: number
}

export interface SlotStore {
  /** Counts one use. True when it is still within the limit. */
  take(req: SlotRequest): Promise<boolean>
}

export function rpcSlotStore(admin: AdminClient): SlotStore {
  return {
    async take(req) {
      const { data, error } = await admin.rpc('take_command_slot', {
        p_user: req.userId,
        p_channel: req.channel,
        p_bucket: req.bucket,
        p_limit: req.limit,
        p_window_seconds: req.windowSeconds,
      })
      if (error) throw new Error(`Could not count this request: ${error.message}`)
      return data === true
    },
  }
}

/** Same arithmetic as the function: fixed windows floored from the epoch. For tests. */
export function memorySlotStore(now: () => number = Date.now): SlotStore {
  const counts = new Map<string, number>()
  return {
    async take(req) {
      const windowMs = req.windowSeconds * 1000
      const start = Math.floor(now() / windowMs) * windowMs
      const key = `${req.userId}|${req.channel}|${req.bucket}|${start}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return n <= req.limit
    },
  }
}
