// The skills the engine serves are the ones that met their own bars in the recorded S19 run.
// Edit the report, a bar or SKILLS_OFF without the others and this fails.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILLS_OFF, celloBackend } from './backends'
import { researcherSpec } from './factory'
import { makeFakeAdmin } from './testing/fake-admin'
import { ScriptedChatModel } from './testing/scripted-model'

type Bar = 'trigger' | 'checks'
type Row = { skill: string; trigger: number | null; checks: number | null }

const skillsDir = path.join(process.cwd(), 'skills')
const folders = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const evalDir = path.join(process.cwd(), 'lib/evals/agent')
const report = JSON.parse(readFileSync(path.join(evalDir, 'reports/skills-s19.json'), 'utf8')) as { perSkill: Row[] }
const bars = (JSON.parse(readFileSync(path.join(evalDir, 'thresholds.json'), 'utf8')) as { skills: Record<string, Record<Bar, number>> }).skills

// "cannot read" (null) misses the bar, never passes it.
const failing = (r: Row): Bar[] => (['trigger', 'checks'] as Bar[]).filter((b) => r[b] === null || r[b]! < bars[r.skill][b])

describe('skills that are switched off', () => {
  it('has a bar and a report row for every skill folder', () => {
    expect(Object.keys(bars).sort()).toEqual(folders)
    expect(report.perSkill.map((r) => r.skill).sort()).toEqual(folders)
  })

  it('lists exactly the skills the report shows below their own bars', () => {
    for (const r of report.perSkill) expect([r.skill, SKILLS_OFF[r.skill] ?? []]).toEqual([r.skill, failing(r)])
  })

  it('serves exactly the skills that are not off', async () => {
    const backend = celloBackend({ admin: makeFakeAdmin(), userId: 'u1', skillsDir })
    const served = (await backend.ls('/skills/')).files?.map((f) => f.path.split('/').filter(Boolean)[1]).sort()
    expect(served).toEqual(folders.filter((f) => !(f in SKILLS_OFF)))
  })

  it('takes a skill from the Researcher only when it missed its output checks', () => {
    const ctx = { admin: makeFakeAdmin(), userId: 'u1', apiKeys: { openrouter: 'k', userId: 'u1' }, deadlineAt: Date.now() + 60_000 }
    const spec = researcherSpec({ ctx, model: new ScriptedChatModel({ script: [] }), fallbacks: [], skillsDir } as never)
    for (const s of ['company-research', 'visa-sponsorship']) {
      const body = readFileSync(path.join(skillsDir, s, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim()
      expect(String(spec.systemPrompt).includes(body)).toBe(!SKILLS_OFF[s]?.includes('checks'))
    }
  })
})
