// Prompt documents for the shortlist. Each one is a self-contained mode
// document under apps/web/prompts (role_requirements, role_chance, role_want).
//
// They are deliberately NOT composed with _shared.md: that file carries the
// 0-100 fit-score bands of the retired match score, which would contradict
// these prompts. The central prompt policy is added in this one function, so
// when the policy package lands it is a one-line change here.

import { loadModeDoc, promptRef } from '@/lib/harness/prompts'

export type ScoringPromptName = 'role_requirements' | 'role_chance' | 'role_want'

export function scoringSystem(name: ScoringPromptName, stableContext?: string): string {
  const doc = loadModeDoc(name)
  return stableContext && stableContext.trim() ? `${doc}\n\n---\n\n${stableContext.trim()}` : doc
}

export function scoringPromptRef(name: ScoringPromptName): { name: string; hash: string } {
  return promptRef(name)
}
