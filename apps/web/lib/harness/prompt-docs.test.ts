// The prompt documents for the written outputs and the mail classifiers are held
// to one shape: what the prompt is for, what it receives, what it returns, the
// rules (grounding, citation, refusing on thin evidence), and worked examples.
// And to the house rules: no long dashes, and no length stated twice.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROMPT_DOC_NAMES } from './prompts'

const DOCS = [
  'outreach',
  'judge_claims',
  'judge_specificity',
  'cv_tailor',
  'company_researcher',
  'visa',
  'gmail_classify',
  'reply_classify',
  'follow_upper',
] as const

const read = (name: string) => readFileSync(join(process.cwd(), 'prompts', `${name}.md`), 'utf8')

describe('prompt documents', () => {
  it.each(DOCS)('%s has job, inputs, output, rules and examples, in that order', (name) => {
    const headings = [...read(name).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
    expect(headings).toEqual(['Job', 'Inputs', 'Output', 'Rules', 'Examples'])
  })

  it.each(DOCS)('%s has no long dash', (name) => {
    expect(read(name)).not.toMatch(/[–—]/)
  })

  it.each(DOCS)('%s is registered so it is hashed into the trace', (name) => {
    expect([...PROMPT_DOC_NAMES]).toContain(name)
  })

  it.each(DOCS)('%s does not paste the shared policy or the voice rules', (name) => {
    const text = read(name)
    expect(text).not.toContain('Sources of Truth (EXCLUSIVE)')
    expect(text).not.toContain('Hard bans (Tier 1')
  })

  it('every output document shows a JSON example that parses (except the plain-text status line)', () => {
    for (const name of DOCS.filter((n) => n !== 'follow_upper')) {
      const blocks = [...read(name).matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1])
      expect(blocks.length, name).toBeGreaterThan(0)
      for (const b of blocks) {
        // Schema sketches with placeholders are allowed to be shown loosely; examples are real JSON.
        if (/^\s*\{[\s\S]*\}\s*$/.test(b) && !/"string"|\.\.\./.test(b)) expect(() => JSON.parse(b), `${name}: ${b.slice(0, 60)}`).not.toThrow()
      }
    }
  })

  it('the voice document no longer states lengths the surface prompts own', () => {
    const voice = read('_voice')
    expect(voice).not.toMatch(/300-420|under 120 words/)
  })
})
