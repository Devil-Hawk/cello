'use client'

// The page carrier: while a Cello page is open, it runs the person's queued model jobs
// on their own computer (R2, Ollama or LM Studio on loopback) or in their own browser
// (R1, a small model in a worker). Supabase Realtime tells it a job was queued (one
// websocket, no polling); it claims once per announcement, runs the job and posts the
// text back. It holds no key, no tool and no command, and it renders nothing.
//
// Drained by recursion, not a timer: a claim that finds a job runs it and claims
// again, and stops at the first claim that finds none. Each step does real work.

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { askWorker, DEFAULT_BASE, deviceCanRun, type DeviceNav, type LocalConfig, type LocalRequest, R1_MODEL, runLocal } from './local'
import type { ClaimedJob } from './protocol'

const STORAGE_KEY = 'cello.relay.local'
const BROWSER_KEY = 'cello.relay.browser'

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

/** "This browser" is on or off for this device. */
export const readBrowserModelOn = (): boolean => {
  try {
    return window.localStorage.getItem(BROWSER_KEY) === '1'
  } catch {
    return false
  }
}

export function saveBrowserModelOn(on: boolean): void {
  try {
    window.localStorage.setItem(BROWSER_KEY, on ? '1' : '0')
  } catch {
    /* blocked storage: the browser model stays off */
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** Claim one job at this rung, run it, post the answer, then look for the next. Exported for the tests. */
export async function drain(
  rung: 'R1' | 'R2',
  model: string,
  run: (req: LocalRequest) => Promise<string>,
  send: typeof post = post,
): Promise<number> {
  const claimed = await send('/api/model-jobs/claim', { rung })
  if (!claimed.ok) return 0
  const { job } = (await claimed.json()) as { job: ClaimedJob | null }
  if (!job) return 0
  let answer: { text: string } | { error: string }
  try {
    answer = { text: await run(job.request) }
  } catch (err) {
    answer = { error: err instanceof Error ? err.message.slice(0, 500) : 'The model failed.' }
  }
  await send('/api/model-jobs/result', { job_id: job.job_id, claim_id: job.claim_id, model, ...answer })
  return 1 + (await drain(rung, model, run, send))
}

// One worker per page, made the first time an R1 job needs it. The WebLLM chunk is
// fetched then and never otherwise.
let worker: Worker | null = null
const browserModel = (req: LocalRequest): Promise<string> => {
  worker ??= new Worker(new URL('../models/webllm.worker.ts', import.meta.url), { type: 'module' })
  return askWorker(worker, req)
}

export function PageCarrier({ userId, enabled }: { userId: string; enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    let busy = false
    let again = false
    const work = async (): Promise<void> => {
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        const cfg = readLocalConfig()
        if (cfg) await drain('R2', cfg.model, (req) => runLocal(cfg, req))
        if (readBrowserModelOn() && (await deviceCanRun(navigator as unknown as DeviceNav)) === null) await drain('R1', R1_MODEL, browserModel)
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
        () => void work().catch(() => undefined),
      )
      .subscribe((status) => {
        // Jobs queued while no page was open are claimed on connect.
        if (status === 'SUBSCRIBED') void work().catch(() => undefined)
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [userId, enabled])

  return null
}
