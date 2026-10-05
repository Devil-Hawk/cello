// What the shortlist pipeline needs from storage. The Supabase implementation is
// lib/scoring/supabase-store.ts; the in-memory one below backs the tests and the
// offline evaluation, so both run exactly the same pipeline code.

import type { BlendModel, FitEvidence } from './taste'
import type { RequirementsOutcome } from './requirements'
import type { Assessment, ReactionRecord, ShortlistPick } from './types'

export interface StoredTaste {
  model: BlendModel
  evidence: FitEvidence
}

export interface AssessmentToStore extends Assessment {
  /** The role's own text at assessment time is not stored; only what the UI and the learning need. */
  wantReason: string | null
}

export interface ScoringStore {
  reactions(userId: string): Promise<ReactionRecord[]>
  setReactionEmbeddings(userId: string, items: { id: string; embedding: number[]; model: string }[]): Promise<void>
  /** Cached requirement reads that are still current. Failed reads are never cached. */
  requirements(userId: string, jobIds: string[]): Promise<Map<string, RequirementsOutcome>>
  saveRequirements(userId: string, entries: Map<string, RequirementsOutcome>): Promise<void>
  embeddings(userId: string, jobIds: string[], model: string): Promise<Map<string, number[]>>
  saveEmbeddings(userId: string, model: string, entries: Map<string, number[]>): Promise<void>
  taste(userId: string): Promise<StoredTaste | null>
  saveTaste(userId: string, taste: StoredTaste, counts: { n: number; positive: number }): Promise<void>
  saveAssessments(userId: string, rows: AssessmentToStore[]): Promise<void>
  saveShortlist(userId: string, forDate: string, picks: ShortlistPick[]): Promise<void>
}

/** In-memory store for tests and the offline evaluation. */
export class MemoryStore implements ScoringStore {
  reactionRows: ReactionRecord[] = []
  requirementRows = new Map<string, RequirementsOutcome>()
  embeddingRows = new Map<string, number[]>()
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
  async saveRequirements(_u: string, entries: Map<string, RequirementsOutcome>): Promise<void> {
    for (const [id, v] of entries) if (v.kind !== 'failed') this.requirementRows.set(id, v)
  }
  async embeddings(_u: string, jobIds: string[], model: string): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>()
    for (const id of jobIds) {
      const v = this.embeddingRows.get(`${model}:${id}`)
      if (v) out.set(id, v)
    }
    return out
  }
  async saveEmbeddings(_u: string, model: string, entries: Map<string, number[]>): Promise<void> {
    for (const [id, v] of entries) this.embeddingRows.set(`${model}:${id}`, v)
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
