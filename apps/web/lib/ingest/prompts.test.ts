import { describe, expect, it } from 'vitest'
import { loadModeDoc, promptRef } from '../harness/prompts'

describe('ingestion prompts', () => {
  for (const name of ['page_reader', 'requirements']) {
    it(`${name} resolves, is hashed for tracing and has no em dash`, () => {
      const doc = loadModeDoc(name)
      expect(doc.length).toBeGreaterThan(500)
      expect(promptRef(name).hash).toMatch(/^[0-9a-f]{8}$/)
      expect(doc).not.toContain('—')
    })
  }
})
