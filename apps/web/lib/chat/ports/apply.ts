// Everything Chat needs from the pipeline, and nothing else: add a line to an application's timeline, move it, and read
// what waits on the person. The shapes are the pipeline's and Needs you's own (their pushed types files), so the real
// adapter (apply.pipeline.ts, behind the chat_apply switch, written when K13 and K20 are on main) changes no caller.
// apply.fake.ts implements it for tests.

import type { NeedsYouList } from '@/lib/needs-you/types'
import type { ApplicationState, PipelineEvent, RecordEvent } from '@/lib/pipeline/types'

export interface AdvanceInput {
  userId: string
  applicationId: string
  to: ApplicationState
  /** A sentence for the person, at most 280 characters. */
  sentence: string
  /** The same key returns the first event instead of moving twice. */
  idempotencyKey: string
}

export interface ApplyPort {
  recordEvent: RecordEvent
  /** Moves the application and writes the one event that says so. */
  advance: (input: AdvanceInput) => Promise<PipelineEvent>
  /** What waits on this person, in Needs you's order. */
  needsYou: (userId: string, now?: Date) => Promise<NeedsYouList>
}
