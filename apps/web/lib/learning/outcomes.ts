// Accepted strategy proposals, kept as learnings. The person accepting a proposal is their
// own act, so the learning is active and origin person; the "before" snapshot the effect is
// measured against rides in its metadata (lib/strategy/measure.ts reads it back).
// Replaces the old outcomes table.

import { getMemoryStore } from '../memory/mem0-store'
import type { MemoryStore } from '../memory/types'
import type { AcceptedProposalRecord } from '../strategy/measure'
import { LEARNING_SCOPE } from './types'

const KEY_PREFIX = 'outcome:accepted:'

export interface AcceptedProposal extends AcceptedProposalRecord {
  /** The learning's id. */
  id: string
}

/** Records one acceptance. A proposal id is only a per-report counter, so each acceptance has its own key. */
export async function saveAcceptedProposal(userId: string, rec: AcceptedProposalRecord, isDemo = false, store: MemoryStore = getMemoryStore()): Promise<AcceptedProposal> {
  const key = `${KEY_PREFIX}${rec.proposalId}:${rec.acceptedAt}`
  const item = await store.add(userId, {
    fact: `You accepted: ${rec.title}`,
    scope: LEARNING_SCOPE,
    isDemo,
    refs: {
      key,
      kind: 'outcome',
      effect: 'search.propose',
      params: { proposalId: rec.proposalId, question: rec.question },
      status: 'active',
      origin: 'person',
      evidence: [],
      n: 0,
      updated_at: rec.acceptedAt,
      title: rec.title,
      accepted_at: rec.acceptedAt,
      metrics_before: rec.metricsBefore,
    },
  })
  return { id: item.id, ...rec }
}

export async function listAcceptedProposals(userId: string, store: MemoryStore = getMemoryStore()): Promise<AcceptedProposal[]> {
  const items = await store.getAll(userId, { filters: { scope: LEARNING_SCOPE, kind: 'outcome', effect: 'search.propose' } })
  const out: AcceptedProposal[] = []
  for (const m of items) {
    const md = m.metadata ?? {}
    const params = (md.params ?? {}) as Record<string, unknown>
    if (typeof md.key !== 'string' || !md.key.startsWith(KEY_PREFIX) || typeof params.proposalId !== 'string' || !md.metrics_before) continue
    out.push({
      id: m.id,
      proposalId: params.proposalId,
      question: String(params.question ?? ''),
      title: String(md.title ?? m.memory),
      acceptedAt: String(md.accepted_at),
      metricsBefore: md.metrics_before as AcceptedProposalRecord['metricsBefore'],
    })
  }
  return out.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
}
