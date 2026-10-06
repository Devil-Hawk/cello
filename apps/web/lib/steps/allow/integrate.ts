// Raw model calls the scoring and agent-engine package (integrate) has not moved behind a step yet.
// Delete an entry in the same commit that moves its call; the source test fails on a stale entry.

import type { AllowEntry } from './types'

export const allow: AllowEntry[] = [
  { file: 'app/api/roles/[id]/fit/route.ts', reason: 'Assesses one role with callLlm; integrate moves it behind the chance step.' },
  { file: 'app/api/shortlist/route.ts', reason: 'Assesses the roles it picks with callLlm; integrate moves it behind the chance step.' },
  { file: 'lib/agents/model.ts', reason: 'Builds the engine chat model; integrate moves it to the model factory.' },
  { file: 'lib/evals/claims-judge.ts', reason: 'The claims judge calls a model of a different family than the writer; integrate moves it behind a step.' },
  { file: 'lib/outreach/reply.ts', reason: 'Classifies a reply with callLlm; integrate moves it behind a step.' },
  { file: 'lib/resume/import/vision.ts', reason: 'Reads a photo or scan with the key the person brought; resume moves it behind the resume.photo step.' },
  { file: 'lib/scoring/inputs.ts', reason: 'Runs the role assessment with callLlm; integrate moves it behind the chance step.' },
  { file: 'scripts/evals/outputs/legacy/judges.ts', reason: 'Eval script; scripts keep their own judges.' },
]
