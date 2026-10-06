// What Settings > Models reads and tests (blueprint 11.1, 11.3). No screen here: PG4
// builds it over the commands models.get, settings.models and models.test.

import { loadApiKeys } from '../harness/keys'
import { callLlm } from '../harness/llm'
import type { AdminClient } from '../harness/types'
import type { Ceiling, Rung } from './doors.types'
import { availableRungs, CALLABLE, routeFor } from './ladder'
import { nextUtcMidnight } from './waiting'

/** OpenRouter's free allowance: 50 requests a day, 1,000 once $10 of credit has been bought. */
const FREE_LIMIT = { plain: 50, credited: 1000 }

const SHOWN: Rung[] = ['R1', 'R2', 'R3', 'R4']

export interface ModelSettings {
  rungs: { rung: Rung; state: 'ready' | 'not_set_up' }[]
  ceiling: Ceiling
  order: Rung[]
  creditBought: boolean
  /** Free-model calls today, counted from the spend ledger. Information only: the limit sentence fires on OpenRouter's 429. */
  freeToday: number
  freeLimit: number
  resetsAt: string
}

export async function readModelSettings(admin: AdminClient, userId: string): Promise<ModelSettings> {
  const keys = await loadApiKeys(admin, userId)
  // loadApiKeys always attaches the person's models.
  const models = keys.models as NonNullable<typeof keys.models>
  const ready = availableRungs(keys, 'R4')
  const resetsAt = nextUtcMidnight()
  const { count } = await admin
    .from('llm_spend')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('rung', 'R3')
    .gte('created_at', new Date(resetsAt.getTime() - 86_400_000).toISOString())
  return {
    rungs: SHOWN.map((rung) => ({ rung, state: ready.includes(rung) ? 'ready' : 'not_set_up' })),
    ceiling: models.ceiling,
    order: models.order,
    creditBought: models.creditBought,
    freeToday: count ?? 0,
    freeLimit: models.creditBought ? FREE_LIMIT.credited : FREE_LIMIT.plain,
    resetsAt: resetsAt.toISOString(),
  }
}

/** One short call on every rung that is set up, through callLlm, so the ceiling, the ledger
 *  and the traces apply to the test as they do to any call. A rung above the ceiling says so. */
export async function testRungs(admin: AdminClient, userId: string, signal?: AbortSignal): Promise<{ rung: Rung; ok: boolean; sentence: string }[]> {
  const keys = await loadApiKeys(admin, userId)
  const out: { rung: Rung; ok: boolean; sentence: string }[] = []
  for (const rung of availableRungs(keys, 'R4').filter((r) => CALLABLE.has(r))) {
    const { via, model } = routeFor(rung, keys)
    try {
      await callLlm(keys, { prompt: 'Reply with OK', maxTokens: 8, temperature: 0, via, model, name: 'models.test', door: 'session' }, signal)
      out.push({ rung, ok: true, sentence: 'It answered.' })
    } catch (error) {
      out.push({ rung, ok: false, sentence: (error instanceof Error ? error.message : 'It did not answer.').slice(0, 300) })
    }
  }
  return out
}
