// Harness runtime — agent registry.
//
// This file owns ONLY the wiring: it maps each executable agent_type to its
// implementation. Each implementation lives in its own file under ./agents/ so
// ownership stays disjoint — other workstreams edit ./agents/<type>.ts and never
// touch this file (unless a brand-new agent_type is introduced).

import type { AgentFn, StepAgentType, UnitType } from './types'
import { STEP_AGENT_TYPES, UNIT_TYPES, BulkMatcherInput, DigestInput, OutreachInput, ResumeOptimizerInput } from './schemas'

import { sourcer } from './agents/sourcer'
import { matcher, userCompanyIds } from './agents/matcher'
import { enricher } from './agents/enricher'
import { cv_tailor } from './agents/cv_tailor'
import { applier } from './agents/applier'
import { verifier } from './agents/verifier'
import { follow_upper } from './agents/follow_upper'
import { interview_prep } from './agents/interview_prep'
import { company_researcher } from './agents/company_researcher'
import { contact_sourcer } from './agents/contact_sourcer'

import { runBulkMatch } from './agents/bulk_matcher'
import { composeAndStoreDigest } from './agents/digest'
import { generateOutreachDraft } from './agents/outreach'
import { optimizeResume } from './agents/resume_optimizer'
import { strategist } from './agents/strategist'
import { analyst } from './agents/analyst'
import { coach } from './agents/coach'
import { resolveTargeting } from '@/lib/targeting'
import { resolveTargetTitles } from '@/lib/targeting/titles'

// Property GETTERS, not value shorthand: this module sits inside import
// cycles (agents import helpers that import back through here), and a plain
// object literal would evaluate every agent binding at module-eval time — a
// TDZ ReferenceError under Next's compiled build for whichever module is
// mid-initialization (vitest's ESM transform happens not to trip it, so only
// `next build` sees the crash). Getters defer the read to call time, when
// every module in the cycle has finished initializing.
export const registry: Record<StepAgentType, AgentFn> = {
  get sourcer() { return sourcer },
  get matcher() { return matcher },
  get enricher() { return enricher },
  get cv_tailor() { return cv_tailor },
  get applier() { return applier },
  get verifier() { return verifier },
  get follow_upper() { return follow_upper },
  get interview_prep() { return interview_prep },
  get company_researcher() { return company_researcher },
  get contact_sourcer() { return contact_sourcer },
}

// --- The five graph-port stragglers, wrapped behind the AgentFn shape -------
//
// None of runBulkMatch/composeAndStoreDigest/generateOutreachDraft/
// optimizeResume(AndSave) is modified here or anywhere else in this file —
// each wrapper below only adapts a StepContext into that function's existing
// argument shape and its existing return value into an AgentResult. See
// lib/harness/schemas.ts's "The five graph-port stragglers" section for where
// each input/output shape was derived from.

/** bulk_matcher — mirrors the `matcher` AgentFn's own profile/targeting/
 *  companyIds resolution (lib/harness/agents/matcher.ts's `matcher` below)
 *  rather than requiring a caller to already know the user's companyIds. */
const bulk_matcher: AgentFn = async (ctx) => {
  const input = BulkMatcherInput.parse(ctx.input ?? {})
  const { data: profile } = await ctx.admin
    .from('profiles')
    .select('resume_text, preferences')
    .eq('id', ctx.userId)
    .single()
  const resume = ((profile?.resume_text as string | null) ?? '').trim()
  const prefs = (profile?.preferences as Record<string, unknown> | null) ?? {}
  const targeting = resolveTargeting(prefs)
  const companyIds =
    input.companyIds && input.companyIds.length > 0 ? input.companyIds : await userCompanyIds(ctx.admin, ctx.userId)

  const result = await runBulkMatch({
    admin: ctx.admin,
    userId: ctx.userId,
    companyIds,
    resume,
    targeting,
    llm: ctx.llm,
    limit: input.limit ?? 25,
    model: input.model,
    effort: input.effort,
    jobIds: input.jobIds,
    targetTitles: input.targetTitles ?? resolveTargetTitles(prefs),
  })
  return { output: result, tokensUsed: result.tokensUsed }
}

/** digest — compose + persist only (see schemas.ts's DigestInput doc: no
 *  Gmail provider_token exists in a graph-run context, so this always
 *  degrades to the same compose-and-store path cron uses). */
const digest: AgentFn = async (ctx) => {
  const input = DigestInput.parse(ctx.input ?? {})
  const result = await composeAndStoreDigest(ctx.admin, ctx.userId, { force: input.force })
  return { output: result, tokensUsed: 0 }
}

/** outreach — generateOutreachDraft never throws (it falls back to a
 *  deterministic template internally), so this wrapper has nothing to catch. */
const outreach: AgentFn = async (ctx) => {
  const input = OutreachInput.parse(ctx.input ?? {})
  const draft = await generateOutreachDraft(ctx.llm, input)
  return { output: draft, tokensUsed: draft.tokensUsed }
}

/**
 * resume_optimizer — ACT ONLY (ruling 2, langgraph port design doc Step 4):
 * this AgentFn NEVER persists, regardless of `jobId`. It used to call
 * optimizeResumeAndSave (persisting straight to resume_documents) the moment
 * `jobId` was set — the exact ACT-then-PERSIST-without-VERIFY shape ruling 2
 * forbids, sitting unreached in the graph today (nothing calls
 * runAgentUnit('resume_optimizer', {input:{jobId}}) — app/api/resume/
 * documents/route.ts calls optimizeResumeAndSave directly, outside the graph
 * entirely, and is unaffected by this change).
 *
 * ponytail: no verify/resume-optimizer.ts sibling to lib/graph/verify/
 * cv-tailor.ts exists yet — a containment-gate-then-judge module with no
 * caller is exactly the scaffolding-for-later ponytail forbids. Build it
 * ALONGSIDE whichever caller needs it (most likely: splitting
 * app/api/resume/documents/route.ts's direct optimizeResumeAndSave call the
 * way cv_tailor's act/applier split already works — optimizeResume() already
 * separates the LLM call from createVersion()'s persist, so the pieces are
 * there), not ahead of it.
 */
const resume_optimizer: AgentFn = async (ctx) => {
  const input = ResumeOptimizerInput.parse(ctx.input ?? {})
  const result = await optimizeResume({ resumeText: input.resumeText, job: input.job, llm: ctx.llm })
  return { output: result, tokensUsed: result.tokensUsed }
}

/**
 * Every unit lib/graph/unit.ts#runAgentUnit can run — the ten DAG-executor
 * agents above plus the five stragglers wrapped just above. Keyed by
 * UNIT_TYPES (lib/harness/schemas.ts), which is a strict superset of
 * StepAgentType: the five extra keys are real, callable units without being
 * plannable (STEP_AGENT_TYPES, asserted unchanged by lib/graph/unit.test.ts,
 * is what the planner may still emit into a DAG).
 */
// No `...registry` spread: spreading evaluates the getters immediately,
// which would put the TDZ hazard right back. Same getter treatment throughout.
export const UNIT_REGISTRY: Record<UnitType, AgentFn> = {
  get sourcer() { return sourcer },
  get matcher() { return matcher },
  get enricher() { return enricher },
  get cv_tailor() { return cv_tailor },
  get applier() { return applier },
  get verifier() { return verifier },
  get follow_upper() { return follow_upper },
  get interview_prep() { return interview_prep },
  get company_researcher() { return company_researcher },
  get contact_sourcer() { return contact_sourcer },
  get bulk_matcher() { return bulk_matcher },
  get digest() { return digest },
  get outreach() { return outreach },
  get resume_optimizer() { return resume_optimizer },
  get strategist() { return strategist },
  get analyst() { return analyst },
  get coach() { return coach },
}

/** Runtime-checkable version of UNIT_REGISTRY's key set, for tests/assertions
 *  that want to iterate every unit type without importing zod. */
export const UNIT_TYPE_LIST = UNIT_TYPES

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
