// Tables this lane owns, and how each says where its values come from.
// Add a table here in the same commit as the migration that creates it.

import type { ProvenanceTable } from './types'

export const tables: ProvenanceTable[] = [
  { table: 'applications', provenance: 'person' },
  { table: 'contacts', provenance: 'person' },
  { table: 'companies', provenance: 'person' },
  { table: 'apply_credentials', provenance: 'person' },
  { table: 'resume_documents', provenance: 'person' },
  { table: 'kb_sources', provenance: 'person' },
  { table: 'kb_documents', provenance: 'person' },
  { table: 'kb_chunks', provenance: 'person' },
  { table: 'user_mcp_servers', provenance: 'person' },
  { table: 'copilot_conversations', provenance: 'person' },
  { table: 'interactions', provenance: 'person' },
  { table: 'agent_runs', provenance: 'code' },
  { table: 'api_tokens', provenance: 'code' },
  { table: 'apply_phase_tokens', provenance: 'code' },
  { table: 'command_slots', provenance: 'code' },
  { table: 'graph_threads', provenance: 'code' },
  { table: 'ingestion_runs', provenance: 'code' },
  { table: 'llm_spend', provenance: 'code' },
  { table: 'trace_spans', provenance: 'code' },
  { table: 'eval_verdicts', provenance: 'code' },
  { table: 'a2a_tasks', provenance: 'code' },
  { table: 'company_merge_candidates', provenance: 'code' },
  { table: 'copilot_messages', provenance: 'code', retiredBy: 'K24a' },
  { table: 'application_drafts', provenance: 'code', retiredBy: 'K17' },
  { table: 'outreach_messages', provenance: 'code', retiredBy: 'K17' },
  { table: 'company_dossiers', provenance: 'code', retiredBy: 'K24b' },
  { table: 'resume_claims', provenance: 'code', retiredBy: 'K17b' },
  { table: 'claim_evidence', provenance: 'code', retiredBy: 'K17b' },
]
