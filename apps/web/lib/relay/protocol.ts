// What travels between the server and a carrier, and the rules both ends apply to it.
//
// The relay moves text only. A carrier gets a prompt the server built and returns
// text. It holds no key, no tool and no command; the server parses whatever comes
// back with the step's own schema and checks, so a forged answer is still a model
// answer, limited to the person's own account.

import { createHash } from 'node:crypto'
import { z } from 'zod'

/** The two rungs a carrier can run. R3 and R4 are the server's own models. */
export const RELAY_RUNGS = ['R1', 'R2'] as const
export type RelayRung = (typeof RELAY_RUNGS)[number]

/** Every rung in order, lowest first. "Highest Cello may use" is one of these. */
export const RUNG_ORDER = ['R0', 'R0s', 'R1', 'R2', 'R3', 'R4'] as const
export type AnyRung = (typeof RUNG_ORDER)[number]

export const rungRank = (r: AnyRung): number => RUNG_ORDER.indexOf(r)

/** A rung above the person's ceiling is never used, so no job is ever enqueued for it. */
export function withinCeiling(rung: AnyRung, ceiling: AnyRung): boolean {
  return rungRank(rung) <= rungRank(ceiling)
}

/**
 * The only steps a small in-browser model may run (blueprint 11.2's R1 rows). The server
 * checks this once, at enqueue: a carrier runs whatever it is given.
 */
export const R1_STEPS: ReadonlySet<string> = new Set([
  'requirements',
  'inbox.classify',
  'inbox.employer',
  'profile.pick',
  'answer.category',
  'companies.resolve_name',
])

/** Most a carrier may send back: 64 KB, the same limit the table enforces. */
export const MAX_RESULT_BYTES = 64 * 1024

/** The slice the server waits for a carrier: 120 s, inside the 240 s function slice. */
export const RELAY_WAIT_MS = 120_000

/** A claim from the extension may hold the request open this long, once. */
export const CLAIM_WAIT_MAX_S = 25

export const JobMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(200_000),
})

/** The request a carrier runs: the messages the server built and nothing else. */
export const JobRequest = z.object({
  messages: z.array(JobMessage).min(1).max(64),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(8192).optional(),
})
export type JobRequest = z.infer<typeof JobRequest>

/** What a carrier posts back: text, or an error sentence, and the model that ran. */
export const ResultBody = z
  .object({
    job_id: z.string().uuid(),
    claim_id: z.string().uuid(),
    model: z.string().min(1).max(100),
    text: z.string().optional(),
    error: z.string().max(500).optional(),
  })
  .refine((b) => (b.text === undefined) !== (b.error === undefined), {
    message: 'send either text or an error, not both',
  })
export type ResultBody = z.infer<typeof ResultBody>

export const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

/** The same ask hashes the same, so a step that re-runs finds its job. */
export function promptHash(stepId: string, rung: RelayRung, request: JobRequest): string {
  return createHash('sha256').update(JSON.stringify([stepId, rung, request])).digest('hex')
}

/** A job as a carrier sees it once it has claimed it. */
export interface ClaimedJob {
  job_id: string
  claim_id: string
  step_id: string
  rung: RelayRung
  request: JobRequest
}

export class RelayWaitError extends Error {
  /** The words the advancer shows while the job waits: R2 "Waiting for your computer", R1 "Waiting until Cello is open again". */
  readonly waiting: string
  constructor(
    readonly jobId: string,
    readonly rung: RelayRung,
  ) {
    super(`No carrier answered job ${jobId} in time.`)
    this.name = 'RelayWaitError'
    this.waiting = rung === 'R1' ? 'Waiting until Cello is open again' : 'Waiting for your computer'
  }
}

export class RelayCeilingError extends Error {
  constructor(rung: AnyRung, ceiling: AnyRung) {
    super(`${rung} is above the highest rung this person allows (${ceiling}).`)
    this.name = 'RelayCeilingError'
  }
}

export class RelayJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayJobError'
  }
}
