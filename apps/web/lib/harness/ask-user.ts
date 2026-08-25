// Structured clarifying questions: the copilot asking the user to DECIDE, with
// typed options, instead of asking in prose and parsing whatever comes back.
//
// WHY THIS EXISTS
//   Ambiguity is the single biggest reason an autonomous run goes wrong. The
//   model either guesses (and does the wrong work, expensively) or asks in
//   prose, which pushes the user back into operating the machinery — the exact
//   failure the product review named: "the user still has to operate the
//   machinery". A typed question turns "what do you want?" into a decision the
//   user makes in one click and the harness can act on without parsing.
//
// WHAT IT IS NOT
//   This is NOT the confirmation gate for irreversible actions. Submitting an
//   application or emailing a real person stays gated by the unconditional
//   server-side check in app/api/copilot/route.ts, which cannot be waived by
//   bypass mode. A question the model composes must never be able to stand in
//   for that gate — otherwise a model could ask "shall I submit? [yes] [no]"
//   and treat its own rendered button as authorisation. Questions here are for
//   INPUT (which roles, which tone, which companies), never for PERMISSION.
//
// SHAPE
//   Modelled on the same idea Claude Code uses: a small number of questions,
//   each with a short header for a chip, 2-4 concrete options, single- or
//   multi-select depending on whether the choices are mutually exclusive, and
//   always an escape hatch so the user is never trapped inside the options the
//   model happened to think of.

/** One selectable answer. `description` carries the trade-off, not filler. */
export interface AskOption {
  label: string
  /** What choosing this actually means or causes. Optional but strongly preferred. */
  description?: string
}

export interface AskQuestion {
  /** Very short label for the chip shown beside the question (<= 16 chars). */
  header: string
  question: string
  options: AskOption[]
  /** True when the choices are not mutually exclusive. */
  multiSelect: boolean
}

export interface AskUserRequest {
  questions: AskQuestion[]
}

/** What the client sends back. Free text from "Other" arrives as an option. */
export interface AskAnswer {
  header: string
  selected: string[]
  /** Anything the user typed in the notes field, verbatim. */
  note?: string
}

export const MAX_QUESTIONS = 4
export const MAX_OPTIONS = 4
const MIN_OPTIONS = 2
const MAX_HEADER = 16

export class AskUserError extends Error {}

/**
 * Validate and normalise what the model asked for.
 *
 * Deliberately strict. A malformed question is not worth rendering: a
 * one-option "choice" is not a choice, and a wall of ten questions is an
 * interrogation that defeats the point of asking at all. Rejecting here gives
 * the model an actionable error it can retry against, which is cheaper than
 * showing the user something incoherent.
 */
export function parseAskUserRequest(raw: unknown): AskUserRequest {
  const body = raw as { questions?: unknown }
  const list = Array.isArray(body?.questions) ? body.questions : null
  if (!list || list.length === 0) {
    throw new AskUserError('ask_user needs a non-empty `questions` array.')
  }
  if (list.length > MAX_QUESTIONS) {
    throw new AskUserError(
      `ask_user allows at most ${MAX_QUESTIONS} questions; you sent ${list.length}. Ask the ones that change what you would do next.`
    )
  }

  const seen = new Set<string>()
  const questions = list.map((entry, i) => {
    const q = entry as Partial<AskQuestion>
    const header = typeof q.header === 'string' ? q.header.trim() : ''
    const question = typeof q.question === 'string' ? q.question.trim() : ''
    if (!header) throw new AskUserError(`Question ${i + 1} is missing a short \`header\`.`)
    if (header.length > MAX_HEADER) {
      throw new AskUserError(
        `Question ${i + 1}'s header "${header}" is ${header.length} chars; keep it under ${MAX_HEADER} so it fits its chip.`
      )
    }
    if (!question) throw new AskUserError(`Question ${i + 1} is missing \`question\` text.`)

    const key = header.toLowerCase()
    if (seen.has(key)) {
      // Answers are keyed by header, so duplicates would silently overwrite.
      throw new AskUserError(`Two questions share the header "${header}"; headers must be unique.`)
    }
    seen.add(key)

    const rawOptions = Array.isArray(q.options) ? q.options : []
    const options: AskOption[] = rawOptions
      .map((o): AskOption | null => {
        const opt = o as Partial<AskOption>
        const label = typeof opt.label === 'string' ? opt.label.trim() : ''
        if (!label) return null
        const description =
          typeof opt.description === 'string' && opt.description.trim()
            ? opt.description.trim()
            : undefined
        return { label, description }
      })
      .filter((o): o is AskOption => o !== null)

    if (options.length < MIN_OPTIONS) {
      throw new AskUserError(
        `Question ${i + 1} ("${header}") has ${options.length} option(s). Give at least ${MIN_OPTIONS} real alternatives — a single option is not a choice.`
      )
    }
    if (options.length > MAX_OPTIONS) {
      throw new AskUserError(
        `Question ${i + 1} ("${header}") has ${options.length} options; keep it to ${MAX_OPTIONS} so the decision stays quick.`
      )
    }

    const labels = new Set(options.map((o) => o.label.toLowerCase()))
    if (labels.size !== options.length) {
      throw new AskUserError(`Question ${i + 1} ("${header}") repeats an option label.`)
    }

    return { header, question, options, multiSelect: q.multiSelect === true }
  })

  return { questions }
}

/**
 * Render the user's answers back into the transcript as the tool result.
 *
 * Plain prose rather than JSON on purpose: this goes back to a language model,
 * and "Roles: backend, infrastructure" is both cheaper and less likely to be
 * misread than a nested object. A skipped question says so explicitly — the
 * model needs to know the difference between "the user chose nothing" and
 * "the user never saw this".
 */
export function formatAskAnswers(answers: AskAnswer[]): string {
  if (answers.length === 0) return 'The user dismissed the questions without answering.'
  return answers
    .map((a) => {
      const chosen = a.selected.length > 0 ? a.selected.join(', ') : '(skipped)'
      return a.note ? `${a.header}: ${chosen} — note: ${a.note}` : `${a.header}: ${chosen}`
    })
    .join('\n')
}
