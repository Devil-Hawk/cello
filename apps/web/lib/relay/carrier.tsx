'use client'

// The page carrier: while a Cello page is open, it runs the person's queued model jobs
// on their own computer. Supabase Realtime tells it a job was queued (one websocket,
// no polling); it claims once per announcement, runs the job on loopback and posts the
// text back. It holds no key, no tool and no command, and it renders nothing.
//
// Drained by recursion, not a timer: a claim that finds a job runs it and claims
// again, and stops at the first claim that finds none. Each step does real work.

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ClaimedJob } from './protocol'
import { DEFAULT_BASE, type LocalConfig, runLocal } from './local'

const STORAGE_KEY = 'cello.relay.local'

/** The person's own choice of local runtime and model, set up in Settings. */
export function readLocalConfig(): LocalConfig | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<LocalConfig>
    if ((c.runtime !== 'ollama' && c.runtime !== 'lmstudio') || !c.model) return null
    return { runtime: c.runtime, model: c.model, baseUrl: c.baseUrl || DEFAULT_BASE[c.runtime] }
  } catch {
    return null
  }
}

export function saveLocalConfig(cfg: LocalConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* storage can be blocked; the carrier then simply has no model to run */
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** Claim one job, run it, post the answer, then look for the next. Exported for the tests. */
export async function drain(
  cfg: LocalConfig,
  deps: { post?: typeof post; run?: typeof runLocal; doFetch?: Parameters<typeof runLocal>[2] } = {},
): Promise<number> {
  const send = deps.post ?? post
  const run = deps.run ?? runLocal
  const claimed = await send('/api/model-jobs/claim', { rung: 'R2' })
  if (!claimed.ok) return 0
  const { job } = (await claimed.json()) as { job: ClaimedJob | null }
  if (!job) return 0
  let answer: { text: string } | { error: string }
  try {
    answer = { text: await run(cfg, job.request, deps.doFetch) }
  } catch (err) {
    answer = { error: err instanceof Error ? err.message.slice(0, 500) : 'The local model failed.' }
  }
  await send('/api/model-jobs/result', { job_id: job.job_id, claim_id: job.claim_id, ...answer })
  return 1 + (await drain(cfg, deps))
}

export function PageCarrier({ userId, enabled }: { userId: string; enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    let busy = false
    let again = false
    const work = async (): Promise<void> => {
      const cfg = readLocalConfig()
      if (!cfg) return
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        await drain(cfg)
      } finally {
        busy = false
      }
      if (again) {
        again = false
        await work()
      }
    }
    const channel = supabase
      .channel(`relay:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'model_jobs', filter: `user_id=eq.${userId}` },
        () => void work(),
      )
      .subscribe((status) => {
        // Jobs queued while no page was open are claimed on connect.
        if (status === 'SUBSCRIBED') void work()
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [userId, enabled])

  return null
}
