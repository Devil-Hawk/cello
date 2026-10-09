// The sentences the API returns for the person to read. Plain, one line where possible, no
// exclamation marks, and none of the words run, thread, step, graph or agent. The UI shows
// them as they are.

export const AGENT_COPY = {
  needsKey: 'Add an OpenRouter key in Settings to use Ask Cello. Free models work.',
  busy: 'Cello is still working on your last message. This reply will appear when it finishes.',
  oldConversation: 'This conversation is from the earlier Copilot. Start a new one to continue.',
  generic: 'Something went wrong on our side. Your conversation is saved; send your message again.',
  signIn: 'Sign in to use Ask Cello.',
  notFound: 'That conversation was not found.',
  demoExpired: 'This demo has ended. Ask whoever shared the code for a fresh one.',
} as const

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The first day of next month, UTC, as "November 1". The cap resets then. */
export function nextBudgetReset(now: Date = new Date()): string {
  const month = (now.getUTCMonth() + 1) % 12
  return `${MONTHS[month]} 1`
}

export function budgetCopy(now: Date = new Date()): string {
  return `This month's AI budget is used up. Raise it in Settings or wait until ${nextBudgetReset(now)}.`
}
