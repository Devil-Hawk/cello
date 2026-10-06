// Tables a person owns by user_id, for demo wipe and account deletion.
// The tables that existed before the lanes started, and this lane's own.
// A table is added in the same commit as the migration that creates it.

import type { OwnedTable } from './types'

/** The expired-demo sweep's tables, in the order it has always deleted them. */
const wiped = ['interactions', 'resume_claims', 'claim_evidence', 'company_merge_candidates', 'eval_verdicts', 'trace_spans', 'a2a_tasks']

/** Kept when a demo expires: real product data, or the demo's spend, which must
 *  never reset (llm_spend keeps the demo cap true). */
const kept = [
  'agent_runs',
  'api_tokens',
  'application_drafts',
  'applications',
  'apply_credentials',
  'apply_phase_tokens',
  'command_slots',
  'companies',
  'company_dossiers',
  'contacts',
  'copilot_conversations',
  'copilot_messages',
  'graph_threads',
  'ingestion_runs',
  'kb_chunks',
  'kb_documents',
  'kb_sources',
  'llm_spend',
  'outreach_messages',
  'resume_documents',
  'strategy_proposal_outcomes',
  'user_mcp_servers',
]

export const owned: OwnedTable[] = [
  ...wiped.map((table) => ({ table, demoWipe: true })),
  ...kept.map((table) => ({ table, demoWipe: false })),
]
