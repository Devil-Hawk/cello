// What the shortlist pipeline needs from storage. The Supabase implementation is
// lib/scoring/supabase-store.ts; the in-memory one below backs the tests and the
// offline evaluation, so both run exactly the same pipeline code.

import type { BlendModel, FitEvidence } from './taste'
import type { RequirementsOutcome } from './posting-requirements'
import type { Assessment, ChanceResult, ReactionRecord, ShortlistPick } from './types'

export interface StoredTaste {
  model: BlendModel
  evidence: FitEvidence
}

export interface AssessmentToStore extends Assessment {
  /** The role's own text at assessment time is not stored; only what the UI and the learning need. */
  wantReason: string | null
  /** The judge's read of the stated preferences alone, and which stated preferences it was read from. */
  stated: { p: number | null; key: string } | null
  /** Which resume the chance was checked against. */
  resumeKey: string | null
}

/** What an earlier assessment of the same role already settled, so it is not paid for twice. */
export interface PriorAssessment {
  statedP: number | null
  statedKey: string | null
  chance: ChanceResult | null
  resumeKey: string | null
}

export interface ScoringStore {
  /** The person's reactions, newest first is not guaranteed; callers sort. */
  reactions(userId: string): Promise<ReactionRecord[]>
  setReactionEmbeddings(userId: string, items: { id: string; embedding: number[]; model: string }[]): Promise<void>
  /** What each role asks for, from the posting reader's record. A role the store knows nothing about is left out of the map. */
  requirements(userId: string, jobIds: string[]): Promise<Map<string, RequirementsOutcome>>
  priorAssessments(userId: string, jobIds: string[]): Promise<Map<string, PriorAssessment>>
  taste(userId: string): Promise<StoredTaste | null>
  saveTaste(userId: string, taste: StoredTaste, counts: { n: number; positive: number }): Promise<void>
  saveAssessments(userId: string, rows: AssessmentToStore[]): Promise<void>
  /** Stores the day's list, replacing any earlier list for that day, and forgets lists older than two weeks. */
  saveShortlist(userId: string, forDate: string, picks: ShortlistPick[]): Promise<void>
}

/** In-memory store for tests and the offline evaluation. */
export class MemoryStore implements ScoringStore {
  reactionRows: ReactionRecord[] = []
  requirementRows = new Map<string, RequirementsOutcome>()
  tasteRow: StoredTaste | null = null
  assessmentRows = new Map<string, AssessmentToStore>()
  shortlists = new Map<string, ShortlistPick[]>()

  async reactions(): Promise<ReactionRecord[]> {
    return this.reactionRows.map((r) => ({ ...r }))
  }
  async setReactionEmbeddings(_u: string, items: { id: string; embedding: number[]; model: string }[]): Promise<void> {
    for (const it of items) {
      const r = this.reactionRows.find((x) => x.id === it.id)
      if (r) {
        r.embedding = it.embedding
        r.embeddingModel = it.model
      }
    }
  }
  async requirements(_u: string, jobIds: string[]): Promise<Map<string, RequirementsOutcome>> {
    const out = new Map<string, RequirementsOutcome>()
    for (const id of jobIds) {
      const v = this.requirementRows.get(id)
      if (v) out.set(id, v)
    }
    return out
  }
  async priorAssessments(_u: string, jobIds: string[]): Promise<Map<string, PriorAssessment>> {
    const out = new Map<string, PriorAssessment>()
    for (const id of jobIds) {
      const a = this.assessmentRows.get(id)
      if (a) out.set(id, { statedP: a.stated?.p ?? null, statedKey: a.stated?.key ?? null, chance: a.chance, resumeKey: a.resumeKey })
    }
    return out
  }
  async taste(): Promise<StoredTaste | null> {
    return this.tasteRow
  }
  async saveTaste(_u: string, taste: StoredTaste): Promise<void> {
    this.tasteRow = taste
  }
  async saveAssessments(_u: string, rows: AssessmentToStore[]): Promise<void> {
    for (const r of rows) this.assessmentRows.set(r.jobId, r)
  }
  async saveShortlist(_u: string, forDate: string, picks: ShortlistPick[]): Promise<void> {
    this.shortlists.set(forDate, picks)
  }
}
