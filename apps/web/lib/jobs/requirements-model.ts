// The model step of requirements extraction. Only reached for a posting the
// deterministic parser could not split into must-have and nice-to-have (see
// needsModel in ./requirements). The answer is validated against a schema and
// then grounded in the posting text; a bad or ungrounded answer is dropped and
// the deterministic result stands.

import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { parseJsonLoose } from '../harness/llm'
import type { ModelCall } from '../ingest/model'
import { ModelAnswerSchema, groundModelAnswer, needsModel, type Requirements } from './requirements'

const POSTING_CHARS = 12_000

export function requirementsSystemPrompt(): string {
  return composeSystemPrompt({ mode: loadModeDoc('requirements'), includeVoice: false })
}

export function requirementsUserPrompt(title: string, description: string): string {
  return `Role title: ${title.trim()}\n\n<posting>\n${description.slice(0, POSTING_CHARS)}\n</posting>`
}

/** Fill the skill lists of `base` from a model, or return `base` unchanged. Never throws. */
export async function completeRequirements(
  base: Requirements,
  input: { title: string; description: string },
  call: ModelCall
): Promise<Requirements> {
  if (!needsModel(base, input.description)) return base
  try {
    const raw = await call({
      system: requirementsSystemPrompt(),
      prompt: requirementsUserPrompt(input.title, input.description),
      name: 'read-job-requirements',
      maxTokens: 700,
      promptRef: promptRef('requirements'),
    })
    if (!raw) return base
    const answer = ModelAnswerSchema.safeParse(parseJsonLoose(raw))
    if (!answer.success) return base
    return groundModelAnswer(base, input.description, answer.data)
  } catch {
    return base
  }
}
