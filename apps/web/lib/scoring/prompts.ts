// Prompt documents for the shortlist. Each one is a self-contained mode document
// under apps/web/prompts (role_chance, role_want), composed
// with the shared grounding rules (_shared.md) the same way every other agent's
// prompt is, so the central prompt policy reaches them.
//
// The voice document (_voice.md) is left out on purpose: it is written for cover
// letters and emails, and its "every claim needs a number or a name" rule would
// contradict the one-sentence reasons these prompts ask for. role_want carries
// its own few style rules.

import { composeSystemPrompt, loadModeDoc, promptRef } from '@/lib/harness/prompts'

export type ScoringPromptName = 'role_chance' | 'role_want'

/** The system prompt for one of the scoring documents, with per-person stable context (stated preferences and decisions, or the resume) after it. */
export function scoringSystem(name: ScoringPromptName, stableContext?: string): string {
  return composeSystemPrompt({ mode: loadModeDoc(name), includeVoice: false, stableContext })
}

export function scoringPromptRef(name: ScoringPromptName): { name: string; hash: string } {
  return promptRef(name)
}
