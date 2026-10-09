// The release/1 prompt documents (frozen copies in ./prompts) composed the way
// release/1 composed them: shared rules, then voice rules, then the mode
// document, then stable per-user context. Used only to measure "before".

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'scripts', 'evals', 'outputs', 'legacy', 'prompts')
const doc = (name: string) => readFileSync(join(DIR, `${name}.md`), 'utf8').trim()

export function legacyDoc(name: string): string {
  return doc(name)
}

export function legacySystem(args: { mode: string; includeVoice?: boolean; stableContext?: string }): string {
  const parts = [doc('_shared')]
  if (args.includeVoice !== false) parts.push(doc('_voice'))
  parts.push(doc(args.mode))
  if (args.stableContext?.trim()) parts.push(args.stableContext.trim())
  return parts.join('\n\n---\n\n')
}
