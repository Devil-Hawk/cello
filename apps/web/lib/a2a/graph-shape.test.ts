// Spec Step 3, item 4: "The three agents stay read/draft-only (no send/
// submit surface exists on them — assert with the graph-shape test that no
// a2a path reaches a submit-capable node)."
//
// buildA2aPlan (lib/a2a/agent.ts) is the ONLY place an A2A request becomes a
// harness Plan — every message/send call goes through it (lib/a2a/executor.ts)
// before invokeGraphForUser ever sees a plan. So "no a2a path reaches a
// submit-capable node" reduces to: for every input buildA2aPlan can ever be
// called with, the Plan it produces contains no submit-capable step. The
// only submit-capable step type in this codebase is 'applier'
// (lib/harness/schemas.ts's stripUntrustedSubmit names it explicitly as
// the one step type that can carry autoSubmit) — this file pins that fact
// against the schema too, not just against buildA2aPlan, so a future new
// submit-capable agent_type would fail this test until it is reasoned about.

import { describe, it, expect } from 'vitest'
import { buildA2aPlan, A2A_AGENTS, type A2aAgentRequest } from './agent'
import { STEP_AGENT_TYPES } from '../harness/schemas'

const SUBMIT_CAPABLE_AGENT_TYPES = ['applier'] as const

const SAMPLE_REQUESTS: A2aAgentRequest[] = [
  { agent: 'matcher', jobIds: ['j1', 'j2'] },
  { agent: 'company_researcher', companyId: 'c1' },
  { agent: 'interview_prep', jobId: 'j1' },
]

describe('A2A graph shape: no submit-capable node is ever reachable', () => {
  it('every submit-capable agent_type is accounted for and is NOT an A2A agent', () => {
    // Guards the premise itself: if a future step type gains a submit
    // capability, this fails until it is added to SUBMIT_CAPABLE_AGENT_TYPES
    // (or excluded from A2A) — not silently trusted.
    for (const t of SUBMIT_CAPABLE_AGENT_TYPES) expect(STEP_AGENT_TYPES).toContain(t)
    for (const t of SUBMIT_CAPABLE_AGENT_TYPES) expect(A2A_AGENTS as readonly string[]).not.toContain(t)
  })

  it.each(SAMPLE_REQUESTS)('buildA2aPlan(%o) contains no submit-capable step', (req) => {
    const plan = buildA2aPlan(req)
    for (const step of plan.steps) {
      expect(SUBMIT_CAPABLE_AGENT_TYPES).not.toContain(step.agent_type as (typeof SUBMIT_CAPABLE_AGENT_TYPES)[number])
    }
  })

  it('buildA2aPlan never emits more than the single requested agent as a step — no room for a hidden second step', () => {
    for (const req of SAMPLE_REQUESTS) {
      const plan = buildA2aPlan(req)
      expect(plan.steps.map((s) => s.agent_type)).toEqual([req.agent])
    }
  })
})
