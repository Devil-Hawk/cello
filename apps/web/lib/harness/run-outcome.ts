// A run that finished can still have skipped its main step (no model key, no
// resume, nothing to rank). The skip is stored on the run's result as
// outputs[label].skippedReason; this turns the first one into a sentence.

const KNOWN: Record<string, string> = {
  'no-llm-key': 'Ranking did not run: no model key.',
  'no-resume': 'Ranking did not run: no resume.',
  'no-companies': 'Ranking did not run: no companies added.',
}

export function runSkipNote(result: unknown): string | null {
  const outputs = (result as { outputs?: unknown } | null)?.outputs
  if (!outputs || typeof outputs !== 'object') return null
  for (const out of Object.values(outputs)) {
    const reason = (out as { skippedReason?: unknown } | null)?.skippedReason
    if (typeof reason === 'string' && reason) return KNOWN[reason] ?? 'Part of this did not run.'
  }
  return null
}
