import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_TYPES, OLD_NAMES, readType, storedNames } from './types'

describe('the made-thing type set', () => {
  it('is the eight types, with no interview prep', () => {
    expect([...ARTIFACT_TYPES]).toEqual(['resume', 'cover_letter', 'answers', 'message', 'research', 'comparison', 'answer', 'shortlist'])
  })

  it('reads an old name as its new one and a new name as itself', () => {
    expect(readType('outreach_email')).toBe('message')
    expect(readType('dossier')).toBe('research')
    for (const t of ARTIFACT_TYPES) expect(readType(t)).toBe(t)
  })

  it('reads nothing else', () => {
    expect(readType('interview_prep')).toBeNull()
    expect(readType('')).toBeNull()
  })

  it('lists every stored name that means a type, for a query that must find rows of either', () => {
    expect(storedNames('message').sort()).toEqual(['message', 'outreach_email'])
    expect(storedNames('research').sort()).toEqual(['dossier', 'research'])
    expect(storedNames('resume')).toEqual(['resume'])
  })

  it('has exactly two renames', () => {
    expect(OLD_NAMES).toEqual({ outreach_email: 'message', dossier: 'research' })
  })
})

// After the contract migration no row holds an old name, so nothing else may name one as an artifact type.
// `dossier` is also an ordinary word (the company record, a contact source), so only its use as a type counts.
describe('the old names live only here and in the migrations', () => {
  const ROOTS = ['app', 'lib', 'components', 'scripts', 'skills', 'prompts'].map((r) => path.resolve(process.cwd(), r))
  const SELF = ['lib/artifacts/types.ts', 'lib/artifacts/types.test.ts']
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = path.join(dir, e)
      if (statSync(full).isDirectory()) return e === 'node_modules' || e === '.next' ? [] : walk(full)
      return /\.(ts|tsx|md|json)$/.test(e) ? [full] : []
    })

  it('no code, prompt, skill or fixture names outreach_email or a dossier artifact type', () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = path.relative(process.cwd(), file)
        if (SELF.includes(rel)) continue
        const src = readFileSync(file, 'utf8')
        if (/outreach_email/.test(src) || /(?:type|artifactType)\s*[:=]\s*['"]dossier['"]|ArtifactContent<'dossier'>|parseContent\('dossier'|renderMarkdown\('dossier'/.test(src)) hits.push(rel)
      }
    }
    expect(hits).toEqual([])
  })
})
