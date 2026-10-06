// Waiting for a carrier without polling. The server hears the job's row change over
// Supabase Realtime and reads the row twice at most: once right after it starts
// listening (the job may already be finished) and once when the time is up. There is
// no loop around a fetch anywhere in the relay.

import type { AdminClient } from '@/lib/harness/types'
import { type JobRow, type JobStatus, readJob } from './queue'

/** Resolves with the finished row, or null when the time runs out first. */
export type JobWaiter = (jobId: string, timeoutMs: number) => Promise<JobRow | null>

const FINAL: ReadonlySet<JobStatus> = new Set(['done', 'failed'])
export const isFinal = (s: JobStatus): boolean => FINAL.has(s)

export function realtimeWaiter(admin: AdminClient, userId: string): JobWaiter {
  return (jobId, timeoutMs) =>
    new Promise<JobRow | null>((resolve) => {
      let settled = false
      const finish = (row: JobRow | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void admin.removeChannel(channel).catch(() => undefined)
        resolve(row)
      }
      const channel = admin
        .channel(`model-job:${jobId}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'model_jobs', filter: `id=eq.${jobId}` },
          (payload) => {
            const row = payload.new as JobRow
            if (row && isFinal(row.status)) finish(row)
          },
        )
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return
          void readJob(admin, userId, jobId)
            .then((row) => {
              if (row && isFinal(row.status)) finish(row)
            })
            .catch(() => undefined)
        })
      const timer = setTimeout(() => {
        void readJob(admin, userId, jobId)
          .then((row) => finish(row && isFinal(row.status) ? row : null))
          .catch(() => finish(null))
      }, timeoutMs)
    })
}

/**
 * One long wait for a carrier's claim: resolves true when a job for this person is
 * inserted, false when the time runs out. The caller claims once after it, never in a loop.
 */
export function waitForInsert(admin: AdminClient, userId: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void admin.removeChannel(channel).catch(() => undefined)
      resolve(v)
    }
    const channel = admin
      .channel(`model-jobs-in:${userId}:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'model_jobs', filter: `user_id=eq.${userId}` },
        () => finish(true),
      )
      .subscribe()
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}
