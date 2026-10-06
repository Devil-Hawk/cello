import type { Hello } from '../lib/messages'
import { send } from '../lib/messages'
import { mountFillButton } from '../ui/bar'
import { resumeAuto, runAuto } from './auto'
import { manualFill, watchManualConfirmation } from './manual'
import { readFields } from './read-fields'

/** A page worth offering the Fill button on: a form with at least three fields. */
function looksLikeApplyForm(): boolean {
  return readFields().filter((f) => f.kind !== 'password').length >= 3
}

/** Runs once per page on the hosted-form hosts. */
export async function boot(): Promise<void> {
  const hello = await send<Hello>({ type: 'hello' }).catch(() => null)
  if (!hello) return
  if (hello.job && hello.pending) return resumeAuto(hello.job, hello.pending)
  if (hello.job) return runAuto(hello.job)
  if (hello.pending && !hello.pending.auto) return watchManualConfirmation(hello.pending.application)
  if (looksLikeApplyForm()) mountFillButton(() => void manualFill())
}
