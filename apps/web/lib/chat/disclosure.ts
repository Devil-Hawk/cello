// The turn's disclosure: what the quiet line under an answer opens onto ("Sources and tools"). Written by code at the
// turn's end from rows, never from the model: the model and effort that ran, each tool by its plain label and
// object, each worker with what it read, each source with its title and host, the time, and the cost, which is
// the sum of the turn's own ledger rows. The model that answered is read from the ledger too, never from the caller:
// a turn that code answered has no rows and says so, and a step-down names what did not answer.

import { REASONING_EFFORTS, type AdminClient, type ReasoningEffort } from '@/lib/harness/types'
import type { ChoiceRung, Ran } from '@/lib/models/choice'
import { ROLES, type Role } from '@/lib/models/roles'
import type { ResolvedMode } from './mode'

/** One role that ran in the turn: the model and the effort its ledger rows name. */
export type Run = Ran & { role: Role }

export interface Disclosure {
  /** The model that answered as Chat, null when none did: this is the entry of `runs` for the chat loop, kept for older readers. */
  ran: Ran | null
  /** Every role that made a model call this turn, from the ledger: Chat, Research, Writing, Background work. Empty when code answered. */
  runs?: Run[]
  /** The mode the turn ran under and why, as code resolved it before the turn (lib/chat/mode.ts). Absent on older turns. */
  mode?: ResolvedMode
  tools: { label: string; object?: string }[]
  workers: { title: string; status: string; reads: number }[]
  sources: { title: string; host: string }[]
  /** The person's own servers left out this turn because they could not be reached. Absent when none were. */
  unreached?: string[]
  seconds: number
  costUsd: number
}

/** The cost of a turn: the sum of its ledger rows, what was settled or else what was held. Free calls are $0 rows. */
export async function turnCost(db: AdminClient, userId: string, turnId: string): Promise<number> {
  const { data } = await db.from('llm_spend').select('estimate_usd, actual_usd').eq('user_id', userId).eq('chat_turn_id', turnId)
  const rows = (data as { estimate_usd: number | string; actual_usd: number | string | null }[] | null) ?? []
  const total = rows.reduce((sum, r) => sum + Number(r.actual_usd ?? r.estimate_usd ?? 0), 0)
  return Math.round(total * 1_000_000) / 1_000_000
}

const RUNGS: readonly ChoiceRung[] = ['R2', 'R3', 'R4']

/**
 * What ran, from the turn's ledger rows, one entry per role: the last settled call with no failed status (a call that failed
 * without an HTTP status is never settled, so it does not count) with the model and the effort the row names. A role whose
 * answering model is not the one chosen for it keeps the chosen one as the step-down's wanted. Empty when no model ran.
 */
export async function runsFromRows(db: AdminClient, userId: string, turnId: string, chosen: Partial<Record<Role, Ran>>): Promise<Run[]> {
  const { data } = await db.from('llm_spend').select('model, rung, role, effort, status, failed_status').eq('user_id', userId).eq('chat_turn_id', turnId).order('created_at', { ascending: true })
  const rows = (data as { model: string; rung: string | null; role: Role | null; effort: string | null; status: string; failed_status: number | null }[] | null) ?? []
  const runs: Run[] = []
  for (const role of ROLES) {
    const row = [...rows].reverse().find((r) => r.role === role && r.status === 'settled' && r.failed_status == null)
    if (!row) continue
    const want = chosen[role]
    const rung = RUNGS.find((r) => r === row.rung) ?? want?.rung ?? 'R3'
    // A call that sent no thinking setting ran with thinking off.
    const effort = (REASONING_EFFORTS as readonly string[]).includes(row.effort ?? '') ? (row.effort as ReasoningEffort) : 'none'
    const ran: Ran = { rung, model: row.model, effort }
    runs.push({ role, ...(want && want.model !== row.model ? { ...ran, steppedDown: { wanted: { rung: want.rung, model: want.model, effort: want.effort }, why: 'model' as const } } : ran) })
  }
  return runs
}

export async function buildDisclosure(
  db: AdminClient,
  userId: string,
  turnId: string,
  input: { ran: Ran | null; runs?: Run[]; mode?: ResolvedMode; tools: Disclosure['tools']; sources: Disclosure['sources']; unreached?: string[]; startedAt: Date; endedAt: Date }
): Promise<Disclosure> {
  const { data } = await db.from('agent_tasks').select('title, status, reads, branch_index, command').eq('user_id', userId).eq('turn_id', turnId).order('created_at', { ascending: true })
  const rows = (data as { title: string; status: string; reads: unknown[] | null; command: string | null }[] | null) ?? []
  return {
    ran: input.ran,
    ...(input.runs ? { runs: input.runs } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    tools: input.tools,
    // The turn's own row ("Cello is working", chat.turn) is still open while this is written and is not a task the turn used.
    workers: rows.filter((r) => r.command !== 'chat.turn').map((r) => ({ title: r.title, status: r.status, reads: r.reads?.length ?? 0 })),
    sources: input.sources,
    ...(input.unreached?.length ? { unreached: input.unreached } : {}),
    seconds: Math.max(0, Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000)),
    costUsd: await turnCost(db, userId, turnId),
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "6 sources, 4 tools, 2 tasks. 0:41. Free." */
export function disclosureLine(d: Pick<Disclosure, 'sources' | 'tools' | 'workers' | 'seconds' | 'costUsd'>): string {
  const time = `${Math.floor(d.seconds / 60)}:${String(d.seconds % 60).padStart(2, '0')}`
  const cost = d.costUsd === 0 ? 'Free' : d.costUsd < 0.01 ? 'Under $0.01' : `$${d.costUsd.toFixed(2)}`
  return `${plural(d.sources.length, 'source')}, ${plural(d.tools.length, 'tool')}, ${plural(d.workers.length, 'task')}. ${time}. ${cost}.`
}
