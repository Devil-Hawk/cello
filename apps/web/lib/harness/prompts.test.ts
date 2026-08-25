// Proves the prompt-document loader resolves apps/web/prompts/*.md via
// `process.cwd()` the same way the deployed function will (see prompts.ts's
// top-of-file note on why `process.cwd()`, not `__dirname`). `pnpm vitest run`
// runs with cwd = apps/web, matching both `next dev` and the Vercel-traced
// function's cwd — this is the closest same-process check available without
// invoking `next build`.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  PROMPT_DOC_NAMES,
  assertPromptDocsResolve,
  composeSystemPrompt,
  getSharedDoc,
  getVoiceDoc,
  loadDoc,
  loadModeDoc,
} from './prompts'

describe('assertPromptDocsResolve', () => {
  it('resolves every known document without throwing', () => {
    expect(() => assertPromptDocsResolve()).not.toThrow()
  })

  it('covers _shared, _voice, and every migrated agent doc today', () => {
    expect(PROMPT_DOC_NAMES).toEqual([
      '_shared',
      '_voice',
      'cv_tailor',
      'resume_optimizer',
      'outreach',
      'follow_upper',
      'interview_prep',
      'company_researcher',
      'planner',
      'visa',
    ])
  })
})

describe('getSharedDoc', () => {
  it('loads real content with the EXCLUSIVE sources-of-truth table', () => {
    const doc = getSharedDoc()
    expect(doc.length).toBeGreaterThan(500)
    expect(doc).toContain('Sources of Truth (EXCLUSIVE)')
    expect(doc).toContain('profiles.resume_text')
    expect(doc).toContain('Shared Fit-Score Bands')
  })

  it('is memoized (same string instance on repeat calls)', () => {
    expect(getSharedDoc()).toBe(getSharedDoc())
  })
})

describe('getVoiceDoc', () => {
  it('loads real content with the hard-ban list', () => {
    const doc = getVoiceDoc()
    expect(doc.length).toBeGreaterThan(300)
    expect(doc).toContain('No em dashes')
    expect(doc).toContain('Self-check')
  })
})

describe('loadModeDoc', () => {
  it('throws a clear, actionable error for a document that does not exist', () => {
    expect(() => loadModeDoc('does_not_exist_agent')).toThrow(/could not read prompt document/)
    expect(() => loadModeDoc('does_not_exist_agent')).toThrow(/outputFileTracingIncludes/)
  })

  it('loadDoc and loadModeDoc resolve the same file for a known name', () => {
    expect(loadModeDoc('_shared')).toBe(loadDoc('_shared'))
  })
})

describe('composeSystemPrompt', () => {
  it('joins shared + voice + mode, in that order, by default', () => {
    const composed = composeSystemPrompt({ mode: 'MODE MARKER: cv_tailor rules go here' })
    const sharedIdx = composed.indexOf('Sources of Truth (EXCLUSIVE)')
    const voiceIdx = composed.indexOf('Voice Guardrail')
    const modeIdx = composed.indexOf('MODE MARKER')
    expect(sharedIdx).toBeGreaterThanOrEqual(0)
    expect(voiceIdx).toBeGreaterThan(sharedIdx)
    expect(modeIdx).toBeGreaterThan(voiceIdx)
  })

  it('omits _voice.md when includeVoice is false', () => {
    const composed = composeSystemPrompt({ mode: 'x', includeVoice: false })
    expect(composed).not.toContain('Voice Guardrail')
  })

  it('appends stableContext last, after the mode block', () => {
    const composed = composeSystemPrompt({ mode: 'MODE MARKER', stableContext: 'RESUME TEXT HERE' })
    expect(composed.indexOf('RESUME TEXT HERE')).toBeGreaterThan(composed.indexOf('MODE MARKER'))
  })

  it('drops an empty/whitespace-only stableContext instead of appending a blank section', () => {
    const composed = composeSystemPrompt({ mode: 'MODE MARKER', stableContext: '   \n  ' })
    expect(composed.trimEnd().endsWith('MODE MARKER')).toBe(true)
  })
})
