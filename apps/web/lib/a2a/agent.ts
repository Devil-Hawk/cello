// A2A vocabulary shared by app/api/a2a/route.ts, lib/a2a/executor.ts and
// lib/a2a/task-store.ts: which agents A2A exposes, how a wire Message's
// parts turn into that agent's validated input, and how a harness
// agent_runs row's status maps onto an A2A TaskState.
//
// WHY ONLY THESE THREE AGENTS, AND WHY ID-ONLY INPUT
//   Spec Architecture table: "A2A: real endpoint via @a2a-js/sdk; matcher +
//   company_researcher + interview_prep; read/draft-only agents; one A2A
//   task = one LangGraph thread." All three already have a real,
//   schema-validated input contract (lib/harness/schemas.ts): matcher takes
//   jobIds against ALREADY-TRACKED jobs, company_researcher takes a
//   companyId, interview_prep takes a jobId (and internally falls back to
//   the caller's own stored resume when no resumeText override is given —
//   lib/harness/agents/interview_prep.ts). A2A_AGENT_REQUEST below matches
//   those contracts exactly and adds NO free-text override field (no raw
//   job-posting text, no resumeText override): those would be new,
//   remote-attacker-controlled strings landing directly in an LLM prompt
//   (interview_prep's buildSystem(resumeText) has no frameJobText call on
//   that path today — see lib/security/injection-chokepoints.test.ts's
//   PENDING_WIRING entry for that file), and nothing here needs to exist to
//   satisfy "score an already-tracked job" / "research an already-tracked
//   company" / "prep for an already-tracked job". This is why
//   app/api/a2a/route.ts is a FORWARDER, not a PROMPT_BUILDER, in that
//   ledger: every field this file accepts is an id, carried to the harness
//   graph, never interpolated into a prompt here.

import { z } from 'zod'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Message, Part } from '@a2a-js/sdk'
import { PlanSchema, MatcherInput, CompanyResearcherInput, InterviewPrepInput } from '../harness/schemas'
import type { Plan, RunStatus } from '../harness/types'

/** The three read/draft-only agents A2A exposes — matches
 *  supabase/migrations/20260819000002_a2a_tasks.sql's `agent` CHECK. */
export const A2A_AGENTS = ['matcher', 'company_researcher', 'interview_prep'] as const
export type A2aAgent = (typeof A2A_AGENTS)[number]

// Built off the harness's own input schemas (lib/harness/schemas.ts) rather
// than re-typed from scratch, so a shape change to the underlying agent
// input can't silently drift out of sync with what A2A validates. Each
// `.extend()` only tightens the general schema to what A2A actually wants —
// see the per-field comments for why each divergence is real.
const MatcherRequest = MatcherInput.extend({
  agent: z.literal('matcher'),
  /** Required (unlike MatcherInput.jobIds, which is optional and defaults to
   *  the whole unscored pool) and bounded: one A2A call is one bounded
   *  request/response, not an invitation to walk the user's entire backlog. */
  jobIds: z.array(z.string().min(1)).min(1).max(25),
})
const CompanyResearcherRequest = CompanyResearcherInput.extend({
  agent: z.literal('company_researcher'),
  companyId: z.string().min(1),
})
// Drops resumeText: a remote-attacker-controlled free-text override has no
// place in this contract (see this file's header comment).
const InterviewPrepRequest = InterviewPrepInput.omit({ resumeText: true }).extend({
  agent: z.literal('interview_prep'),
  jobId: z.string().min(1),
})

export const A2aAgentRequest = z.discriminatedUnion('agent', [MatcherRequest, CompanyResearcherRequest, InterviewPrepRequest])
export type A2aAgentRequest = z.infer<typeof A2aAgentRequest>

/** Finds the first structured `data` part in a Message and validates it
 *  against A2aAgentRequest. Throws a plain Error (zod's own message, or a
 *  "no data part" message) on anything else — the SDK's own _runExecutor
 *  catch turns that into a well-formed FAILED task with the message as its
 *  text, which is the loud-failure behavior this surface wants for a
 *  malformed/unrecognized request (never a silent no-op). */
export function parseA2aAgentRequest(message: Message): A2aAgentRequest {
  const dataPart = message.parts.find((p: Part) => p.content?.$case === 'data')
  const content = dataPart?.content
  if (!content || content.$case !== 'data') {
    throw new Error(
      `No structured data part found. Send one data part shaped like ` +
        `{agent:"matcher", jobIds:[...]}, {agent:"company_researcher", companyId:"..."} or ` +
        `{agent:"interview_prep", jobId:"..."}.`
    )
  }
  return A2aAgentRequest.parse(content.value)
}

/** True when `message.role` decoded to the client-sender role. Anything
 *  else (ROLE_AGENT, ROLE_UNSPECIFIED, or the wire-shape-mismatch
 *  UNRECOGNIZED case scripts/spike-a2a-roundtrip.ts's case B exists to
 *  catch) is refused rather than guessed at. */
export function isUserMessage(message: Message): boolean {
  return message.role === Role.ROLE_USER
}

/** The step input each agent's real Zod schema (lib/harness/schemas.ts)
 *  expects — see this file's header for why it is ID-only. */
function stepInput(req: A2aAgentRequest): Record<string, unknown> {
  switch (req.agent) {
    case 'matcher':
      return { jobIds: req.jobIds }
    case 'company_researcher':
      return { companyId: req.companyId }
    case 'interview_prep':
      return { jobId: req.jobId }
  }
}

/** One-step, chain-compiled Plan (bypasses the LLM planner entirely — same
 *  "already-compiled plan enters harnessRunGraph via agent_runs.plan"
 *  mechanism lib/harness/chains.ts's own builders use), naming the single
 *  requested agent with no dependencies and no possibility of a second,
 *  attacker-influenced step ever entering this plan. */
export function buildA2aPlan(req: A2aAgentRequest): Plan {
  return PlanSchema.parse({
    goal: `A2A: run ${req.agent}`,
    steps: [{ label: 'run', agent_type: req.agent, input: stepInput(req), dependsOn: [] }],
  })
}

/** agent_runs.status (harness/domain vocabulary) -> A2A TaskState (protocol
 *  vocabulary). 'planning'/'queued' both read as SUBMITTED (this A2A path
 *  always hands harnessRunGraph an already-compiled plan — see
 *  buildA2aPlan — so 'planning' is not actually reachable here, but mapped
 *  defensively rather than left to fall through). */
export function runStatusToTaskState(status: RunStatus): TaskState {
  switch (status) {
    case 'queued':
    case 'planning':
      return TaskState.TASK_STATE_SUBMITTED
    case 'running':
    case 'paused':
      return TaskState.TASK_STATE_WORKING
    case 'completed':
    case 'completed_with_errors':
      return TaskState.TASK_STATE_COMPLETED
    case 'failed':
      return TaskState.TASK_STATE_FAILED
    case 'cancelled':
      return TaskState.TASK_STATE_CANCELED
  }
}

/** Non-terminal states are exactly the ones lib/a2a/task-store.ts's load()
 *  should try to advance with one invokeGraphForUser({kind:'continue'})
 *  before reporting — matches THE RESUME RULE (lib/graph/invoke.ts): safe
 *  for a killed-mid-task, parked-at-interrupt, OR already-completed thread
 *  alike. */
export function isNonTerminalRunStatus(status: RunStatus): boolean {
  return status === 'queued' || status === 'planning' || status === 'running' || status === 'paused'
}
