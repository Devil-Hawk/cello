// network.sync, network.remember and network.nudge, run inside inbox.sync after the mail read: each under
// its own time budget and its own heartbeat row, so a slow or failing part never holds the mail read and
// "what runs alone" shows each by name. Switches (instance_flags) decide what runs: the sync is on unless
// T30 or T31 failed on the owner's marks; memories and profiles are for the owner until their measures pass.

import type { SupabaseClient } from '@supabase/supabase-js'
import { withTimeout } from '@/lib/security/untrusted'
import { logApiError } from '@/lib/observability/log'
import { isOwner } from '@/lib/measures/owner'
import { draftNudges } from './nudges'
import { remember } from './memory'
import { networkSync, type SyncFound } from './sync'

const SYNC_MS = 15_000
const NUDGE_MS = 5_000

async function beat(admin: SupabaseClient, userId: string, job: string, patch: Record<string, unknown>): Promise<void> {
  const { data } = await admin.from('job_heartbeats').update(patch).eq('job', job).eq('user_id', userId).select('job')
  if (!data || data.length === 0) await admin.from('job_heartbeats').insert({ job, user_id: userId, ...patch })
}

/** An instance switch; a missing row reads as the default. */
export async function flag(admin: SupabaseClient, key: string, fallback: boolean): Promise<boolean> {
  const { data } = await admin.from('instance_flags').select('on').eq('key', key).maybeSingle()
  return (data as { on: boolean } | null)?.on ?? fallback
}

export async function runNetwork(
  admin: SupabaseClient,
  a: { userId: string; email: string; accessToken: string; isDemo: boolean },
): Promise<void> {
  if (await flag(admin, 'network_sync_live', true).catch(() => true)) {
    const started = Date.now()
    await beat(admin, a.userId, 'network.sync', { started_at: new Date(started).toISOString() }).catch(() => undefined)
    try {
      const { data } = await admin.from('job_heartbeats').select('found').eq('job', 'network.sync').eq('user_id', a.userId).maybeSingle()
      const res = await withTimeout(networkSync(admin, { userId: a.userId, accessToken: a.accessToken, previous: ((data as { found?: SyncFound } | null)?.found ?? {}) as SyncFound }), SYNC_MS, 'network sync')
      await beat(admin, a.userId, 'network.sync', { succeeded_at: new Date().toISOString(), failure: null, duration_ms: Date.now() - started, found: res.found })
      if (a.isDemo) return
      // memories: job threads only; for the owner until S26 passes
      if (isOwner(a.userId) || (await flag(admin, 'network_memory_live', false).catch(() => false))) {
        for (const t of res.jobThreads) {
          for (const contactId of t.contactIds.slice(0, 1)) {
            await remember(admin, a.userId, { threadId: t.threadId, contactId, employerId: t.employerId, applicationId: t.applicationId, accessToken: a.accessToken, isDemo: false }).catch((e) => logApiError('network/remember', e, { userId: a.userId }))
          }
        }
      }
    } catch (e) {
      logApiError('network/sync', e, { userId: a.userId })
      await beat(admin, a.userId, 'network.sync', { failure: 'sync_failed' }).catch(() => undefined)
    }
  }

  const started = Date.now()
  await beat(admin, a.userId, 'network.nudge', { started_at: new Date(started).toISOString() }).catch(() => undefined)
  try {
    const r = await withTimeout(draftNudges(admin, { id: a.userId, email: a.email }), NUDGE_MS, 'network nudge')
    await beat(admin, a.userId, 'network.nudge', { succeeded_at: new Date().toISOString(), failure: null, duration_ms: Date.now() - started, found: r })
  } catch (e) {
    logApiError('network/nudge', e, { userId: a.userId })
    await beat(admin, a.userId, 'network.nudge', { failure: 'nudge_failed' }).catch(() => undefined)
  }
}
