import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { measureStep } from '../../scripts/rungs-eval'
import { ALL_STEPS, entryFrom, readRungs, smokeCases, staleSteps, stepHash, type RungsFile, type StepSet } from './rungs'

const cases = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, messages: [{ role: 'user' as const, content: `mail ${i}` }], expect: 'yes' }))
const set = (prompt: string): StepSet => ({
  prompt,
  bar: 0.8,
  cases: () => cases,
  score: (out) => out.filter((o) => o === 'yes').length / out.length,
})

const fileWith = (steps: RungsFile['steps']): RungsFile => ({ version: 1, steps })
const unmeasured = { promptHash: null, measuredAt: null, rungs: {}, minRung: null, route: false }
const everyStep = (over: RungsFile['steps'] = {}): RungsFile['steps'] => ({ ...Object.fromEntries(ALL_STEPS.map((id) => [id, unmeasured])), ...over })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('rungs.json freshness', () => {
  it('is fresh as committed', () => {
    expect(staleSteps(readRungs())).toEqual([])
  })

  it('names the step whose prompt changed after it was measured', () => {
    const measured = entryFrom({ R3: { model: 'm', cases: 25, score: 0.9, bar: 0.8, pass: true } }, stepHash('inbox.classify', set('old prompt')))
    const file = fileWith(everyStep({ 'inbox.classify': measured }))
    expect(staleSteps(file, { 'inbox.classify': set('old prompt') })).toEqual([])
    expect(staleSteps(file, { 'inbox.classify': set('a new prompt') })).toEqual(['inbox.classify'])
    expect(staleSteps(file, { 'inbox.classify': { ...set('old prompt'), schema: { type: 'object' } } })).toEqual(['inbox.classify'])
  })

  it('names a step with a set that was never measured, a missing step and an unlisted one', () => {
    expect(staleSteps(fileWith(everyStep()), { chance: set('p') })).toEqual(['chance'])
    const without = Object.fromEntries(Object.entries(everyStep()).filter(([id]) => id !== 'requirements'))
    expect(staleSteps(fileWith({ ...without, 'made.up': unmeasured }))).toEqual(expect.arrayContaining(['requirements', 'made.up']))
  })

  it('names a step that says it routes but whose row did not pass', () => {
    const lying = { ...entryFrom({ R1: { model: 'm', cases: 25, score: 0.1, bar: 0.8, pass: false } }, stepHash('chance', set('p'))), route: true, minRung: 'R1' as const }
    expect(staleSteps(fileWith(everyStep({ chance: lying })), { chance: set('p') })).toEqual(['chance'])
  })

  it('knows every step the code declares', () => {
    const root = path.resolve(process.cwd(), 'lib')
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) {
          for (const m of readFileSync(full, 'utf8').matchAll(/defineModelStep\(\s*\{\s*id:\s*'([^']+)'/g)) found.push(m[1] as string)
        }
      }
    }
    walk(root)
    expect(found.filter((id) => !(ALL_STEPS as readonly string[]).includes(id))).toEqual([])
  })
})

describe('routing from a measured row', () => {
  it('does not route when the lowest row failed, or when nothing was measured', () => {
    expect(entryFrom({}, null).route).toBe(false)
    const failed = entryFrom({ R1: { model: 'm', cases: 25, score: 0.5, bar: 0.8, pass: false } }, 'h')
    expect(failed).toMatchObject({ minRung: null, route: false })
  })

  it('routes from the lowest rung that passed', () => {
    const e = entryFrom(
      {
        R1: { model: 'm', cases: 25, score: 0.5, bar: 0.8, pass: false },
        R2: { model: 'm', cases: 25, score: 0.9, bar: 0.8, pass: true },
        R3: { model: 'm', cases: 25, score: 0.95, bar: 0.8, pass: true },
      },
      'h',
    )
    expect(e).toMatchObject({ minRung: 'R2', route: true })
  })

  it('measures R3 through the eval key and keeps the rows it was not asked to redo', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'yes' } }] }), { status: 200 }))
    const kept = { R1: { model: 'old', cases: 25, score: 0.4, bar: 0.8, pass: false } }
    const entry = await measureStep('inbox.classify', set('p'), ['R3'], { admin: {} as AdminClient, userId: 'u', fetchImpl: fetchImpl as unknown as typeof fetch }, kept)
    expect(fetchImpl).toHaveBeenCalledTimes(25)
    expect(entry.rungs.R3).toMatchObject({ cases: 25, score: 1, pass: true })
    expect(entry.rungs.R1?.model).toBe('old')
    expect(entry).toMatchObject({ minRung: 'R3', route: true, promptHash: stepHash('inbox.classify', set('p')) })
  })
})

describe('the smoke set', () => {
  it('is exactly the first ten cases of a step with a set, and empty for one without', () => {
    expect(smokeCases('inbox.classify', { 'inbox.classify': set('p') }).map((c) => c.id)).toEqual(cases.slice(0, 10).map((c) => c.id))
    expect(smokeCases('chance', {})).toEqual([])
  })
})
