// The model step of requirements extraction. Only reached for a posting the
// deterministic parser could not split into must-have and nice-to-have (see
// needsModel in ./requirements). The answer is validated against a schema and
// then grounded in the posting text; a bad or ungrounded answer is dropped and
// the deterministic result stands.
//
// A posting a model has read is stamped model_checked_at, whatever it answered
// (a list, nothing, or text that is not JSON), so it is not asked again until
// its description changes. A call that never reached a model (no key, no free
// model answered, the allowance was spent) is not stamped: that is not an
// answer about the posting.

import { composeSystemPrompt, loadModeDoc, promptRef } from '../harness/prompts'
import { parseJsonLoose } from '../harness/llm'
import { frameJobText } from '@/lib/security/job-text'
import { MODEL_LIMIT, type ModelCall } from '../ingest/model'
import { ModelAnswerSchema, groundModelAnswer, needsModel, type Requirements } from './requirements'

const POSTING_CHARS = 12_000

export function requirementsSystemPrompt(): string {
  return composeSystemPrompt({ mode: loadModeDoc('requirements'), includeVoice: false })
}

export function requirementsUserPrompt(title: string, description: string): string {
  return `Role title: ${title.trim()}\n\n${frameJobText(description, { label: 'JOB POSTING', maxChars: POSTING_CHARS })}`
}

/** Fill the skill lists of `base` from a model, or return `base` unchanged. Never throws. */
export async function completeRequirements(
  base: Requirements,
  input: { title: string; description: string },
  call: ModelCall,
  now: () => Date = () => new Date()
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
    if (!raw || raw === MODEL_LIMIT) return base
    const checked = now().toISOString()
    let parsed: unknown = null
    try {
      parsed = parseJsonLoose(raw)
    } catch {
      /* text that is not JSON is an answer we cannot use; the posting still counts as read */
    }
    const answer = ModelAnswerSchema.safeParse(parsed)
    if (!answer.success) return { ...base, model_checked_at: checked }
    return { ...groundModelAnswer(base, input.description, answer.data), model_checked_at: checked }
  } catch {
    return base
  }
}
