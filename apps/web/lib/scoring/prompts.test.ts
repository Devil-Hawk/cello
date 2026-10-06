import { describe, expect, it } from 'vitest'
import { scoringPromptRef, scoringSystem } from './prompts'

describe('scoringSystem', () => {
  it('puts the shared grounding rules first, then the mode document, then the person\'s own context', () => {
    const sys = scoringSystem('role_want', 'What they told us:\nwants backend roles')
    const shared = sys.indexOf('Shared Context')
    const mode = sys.indexOf('# Role want')
    const context = sys.indexOf('wants backend roles')
    expect(shared).toBeGreaterThanOrEqual(0)
    expect(mode).toBeGreaterThan(shared)
    expect(context).toBeGreaterThan(mode)
  })

  it('leaves out the voice document, which would contradict one-sentence reasons', () => {
    for (const name of ['role_want', 'role_chance'] as const) {
      expect(scoringSystem(name)).not.toContain('Voice Guardrail')
    }
  })

  it('carries no 0-100 score bands for a role, so nothing asks the model for a number', () => {
    for (const name of ['role_want', 'role_chance'] as const) {
      const sys = scoringSystem(name)
      expect(sys).not.toMatch(/job match score/i)
      expect(sys).not.toMatch(/matchThreshold|minimum score/i)
    }
  })

  it('names each document by a short hash so a trace shows which wording ran', () => {
    expect(scoringPromptRef('role_chance')).toMatchObject({ name: 'role_chance', hash: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })
})
