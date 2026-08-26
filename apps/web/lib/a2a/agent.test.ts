import { describe, it, expect } from 'vitest'
import type { Message } from '@a2a-js/sdk'
import { Role } from '@a2a-js/sdk'
import { buildA2aPlan, isUserMessage, parseA2aAgentRequest, runStatusToTaskState, isNonTerminalRunStatus, A2A_AGENTS } from './agent'
import { TaskState } from '@a2a-js/sdk'
import type { RunStatus } from '../harness/types'

function textMessage(text: string): Message {
  return {
    messageId: 'm1',
    contextId: 'c1',
    taskId: 't1',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function dataMessage(data: Record<string, unknown>, role: Role = Role.ROLE_USER): Message {
  return {
    messageId: 'm1',
    contextId: 'c1',
    taskId: 't1',
    role,
    parts: [{ content: { $case: 'data', value: data }, metadata: undefined, filename: '', mediaType: 'application/json' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

describe('isUserMessage', () => {
  it('accepts ROLE_USER', () => {
    expect(isUserMessage(dataMessage({ agent: 'matcher', jobIds: ['j1'] }))).toBe(true)
  })
  it('refuses ROLE_AGENT', () => {
    expect(isUserMessage(dataMessage({}, Role.ROLE_AGENT))).toBe(false)
  })
  it('refuses the UNRECOGNIZED/ROLE_UNSPECIFIED corruption case scripts/spike-a2a-roundtrip.ts case B produces', () => {
    expect(isUserMessage(dataMessage({}, Role.ROLE_UNSPECIFIED))).toBe(false)
    expect(isUserMessage(dataMessage({}, -1 as Role))).toBe(false)
  })
})

describe('parseA2aAgentRequest', () => {
  it('accepts a valid matcher request', () => {
    const req = parseA2aAgentRequest(dataMessage({ agent: 'matcher', jobIds: ['j1', 'j2'] }))
    expect(req).toEqual({ agent: 'matcher', jobIds: ['j1', 'j2'] })
  })
  it('accepts a valid company_researcher request', () => {
    expect(parseA2aAgentRequest(dataMessage({ agent: 'company_researcher', companyId: 'c1' }))).toEqual({
      agent: 'company_researcher',
      companyId: 'c1',
    })
  })
  it('accepts a valid interview_prep request', () => {
    expect(parseA2aAgentRequest(dataMessage({ agent: 'interview_prep', jobId: 'j1' }))).toEqual({ agent: 'interview_prep', jobId: 'j1' })
  })
  it('throws loud on a text-only message (no structured data part) — never silently no-ops', () => {
    expect(() => parseA2aAgentRequest(textMessage('score me against the resume, please'))).toThrow(/no structured data part/i)
  })
  it('throws loud on an unrecognized agent', () => {
    expect(() => parseA2aAgentRequest(dataMessage({ agent: 'applier', jobId: 'x' }))).toThrow()
  })
  it('throws loud on matcher with an empty jobIds array (A2A tightens the general MatcherInput contract)', () => {
    expect(() => parseA2aAgentRequest(dataMessage({ agent: 'matcher', jobIds: [] }))).toThrow()
  })
  it('never accepts a free-text override field (no resumeText, no raw job posting text)', () => {
    // interview_prep's real Zod schema (MatcherInput/InterviewPrepInput's
    // sibling in lib/harness/schemas.ts) allows an optional resumeText — the
    // A2A-facing schema deliberately does not carry it through. Extra keys
    // are just ignored by zod's default object parsing, so this asserts the
    // PARSED result never smuggles one through, not that parsing rejects it.
    const req = parseA2aAgentRequest(dataMessage({ agent: 'interview_prep', jobId: 'j1', resumeText: 'attacker text' }))
    expect(req).not.toHaveProperty('resumeText')
  })
})

describe('buildA2aPlan — read/draft-only by construction', () => {
  it('builds exactly one step, no dependencies, for every A2A agent', () => {
    for (const agent of A2A_AGENTS) {
      const req =
        agent === 'matcher'
          ? { agent, jobIds: ['j1'] }
          : agent === 'company_researcher'
            ? { agent, companyId: 'c1' }
            : { agent, jobId: 'j1' }
      const plan = buildA2aPlan(req)
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0]!.agent_type).toBe(agent)
      expect(plan.steps[0]!.dependsOn).toEqual([])
    }
  })
})

describe('runStatusToTaskState / isNonTerminalRunStatus', () => {
  const cases: [RunStatus, TaskState, boolean][] = [
    ['queued', TaskState.TASK_STATE_SUBMITTED, true],
    ['planning', TaskState.TASK_STATE_SUBMITTED, true],
    ['running', TaskState.TASK_STATE_WORKING, true],
    ['paused', TaskState.TASK_STATE_WORKING, true],
    ['completed', TaskState.TASK_STATE_COMPLETED, false],
    ['completed_with_errors', TaskState.TASK_STATE_COMPLETED, false],
    ['failed', TaskState.TASK_STATE_FAILED, false],
    ['cancelled', TaskState.TASK_STATE_CANCELED, false],
  ]
  it.each(cases)('%s -> %s (non-terminal: %s)', (status, state, nonTerminal) => {
    expect(runStatusToTaskState(status)).toBe(state)
    expect(isNonTerminalRunStatus(status)).toBe(nonTerminal)
  })
})
