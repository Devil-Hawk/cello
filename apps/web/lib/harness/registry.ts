// Harness runtime — agent registry.
//
// This file owns ONLY the wiring: it maps each executable agent_type to its
// implementation. Each implementation lives in its own file under ./agents/ so
// ownership stays disjoint — other workstreams edit ./agents/<type>.ts and never
// touch this file (unless a brand-new agent_type is introduced).

import type { AgentFn, StepAgentType } from './types'
import { STEP_AGENT_TYPES } from './schemas'

import { sourcer } from './agents/sourcer'
import { matcher } from './agents/matcher'
import { enricher } from './agents/enricher'
import { cv_tailor } from './agents/cv_tailor'
import { applier } from './agents/applier'
import { verifier } from './agents/verifier'
import { follow_upper } from './agents/follow_upper'
import { interview_prep } from './agents/interview_prep'
import { company_researcher } from './agents/company_researcher'
import { contact_sourcer } from './agents/contact_sourcer'

export const registry: Record<StepAgentType, AgentFn> = {
  sourcer,
  matcher,
  enricher,
  cv_tailor,
  applier,
  verifier,
  follow_upper,
  interview_prep,
  company_researcher,
  contact_sourcer,
}

export function getAgent(type: StepAgentType): AgentFn {
  const fn = registry[type]
  if (!fn) throw new Error(`No agent registered for type "${type}"`)
  return fn
}

/** Human-readable capability catalog handed to the planner LLM. */
export const AGENT_CATALOG: Record<StepAgentType, string> = {
  sourcer: 'Discover/refresh open jobs from the user\'s tracked companies (official ATS APIs).',
  matcher: 'Score jobs against the user\'s resume and produce match explanations (skills matched, gaps, seniority fit).',
  enricher: 'Add signal to jobs: compensation, seniority, and insider connections from the user\'s own contacts/Gmail graph.',
  cv_tailor: 'Tailor a resume summary + cover letter for a specific job (rephrase true content only, never fabricate).',
  applier: 'Build an application draft for a job and produce a handoff/submit action via official ATS APIs (human-approve by default).',
  verifier: 'Verify an application draft for completeness and knock-out questions before submission.',
  follow_upper: 'Draft a follow-up or outreach message for an application or contact.',
  interview_prep: 'Generate an interview prep kit for a job: tailored questions + STAR stories from the user\'s real resume.',
  company_researcher: 'Assemble a public-source company dossier: funding/news/culture/tech, comp range, and a visa-sponsorship signal.',
  contact_sourcer: 'Source plausible people/contacts at a company for a role (free path needs no keys; Hunter/Apollo are optional BYOK) — draft-supporting data only, never sends anything.',
}

export const EXECUTABLE_AGENT_TYPES = STEP_AGENT_TYPES
