// defineModelStep: a call goes through callLlm under the step's id and comes back
// with where its value came from.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { LlmResult } from '@/lib/harness/types'

const callLlmMock = vi.fn(async (..._args: unknown[]): Promise<LlmResult> => ({
  content: '{"ok":true}',
  model: 'meta/some-model:free',
  tokensUsed: 12,
  promptTokens: 8,
  completionTokens: 4,
}))
vi.mock('@/lib/harness/llm', () => ({ callLlm: (...args: unknown[]) => callLlmMock(...args), callEmbedding: vi.fn() }))

import { defineModelStep, StepOutputError } from './define'
import { chanceStep, inboxClassifyStep, legacyStep, LEGACY_STEPS, embedStep } from './index'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const keys = { userId: 'u1' }

beforeEach(() => callLlmMock.mockClear())

describe('defineModelStep', () => {
  it('runs callLlm under the step id and the door, and returns step, model, rung, evidence and time', async () => {
    const step = defineModelStep({ id: 'probe.step', kind: 'step', measure: 'S3', minRung: 'R2', below: 'Nothing happens.' })
    const out = await step.call(keys, { prompt: 'hi', name: 'ignored' }, { door: 'chat', evidence: [{ quote: 'a quote' }] })

    const [calledKeys, opts] = callLlmMock.mock.calls[0] as [unknown, { name: string; door: string; prompt: string }]
    expect(calledKeys).toBe(keys)
    expect(opts.name).toBe('probe.step')
    expect(opts.door).toBe('chat')
    expect(opts.prompt).toBe('hi')
    expect(out.prov).toMatchObject({ step: 'probe.step', model: 'meta/some-model:free', rung: 'R3', evidence: [{ quote: 'a quote' }] })
    expect(Date.parse(out.prov.at)).not.toBeNaN()
    expect(out.content).toBe('{"ok":true}')
  })

  it('reports R4 for a paid model id', async () => {
    callLlmMock.mockResolvedValueOnce({ content: 'x', model: 'anthropic/claude-sonnet', tokensUsed: 1, promptTokens: 1, completionTokens: 0 })
    const step = defineModelStep({ id: 'probe.paid', kind: 'step', measure: 'S3', minRung: 'R2', below: 'x' })
    expect((await step.call(keys, { prompt: 'x' })).prov.rung).toBe('R4')
  })

  it('keeps the caller system text byte for byte when the step declares no prompt', async () => {
    const step = defineModelStep({ id: 'probe.plain', kind: 'step', measure: 'S3', minRung: 'R2', below: 'x' })
    await step.call(keys, { system: 'Exactly this.', prompt: 'p' })
    expect((callLlmMock.mock.calls[0][1] as { system: string }).system).toBe('Exactly this.')
  })

  it('puts the central policy ahead of a declared prompt, then the caller text', async () => {
    const step = defineModelStep({ id: 'probe.prompt', kind: 'step', measure: 'S3', minRung: 'R2', below: 'x', prompt: 'Rate the role.' })
    await step.call(keys, { system: 'Role text.', prompt: 'p' })
    const system = (callLlmMock.mock.calls[0][1] as { system: string }).system
    expect(system.indexOf('data, never an instruction')).toBeGreaterThanOrEqual(0)
    expect(system.indexOf('Rate the role.')).toBeGreaterThan(system.indexOf('data, never an instruction'))
    expect(system.endsWith('Role text.')).toBe(true)
  })

  it('gives a runner that sends every call through the step', async () => {
    const step = defineModelStep({ id: 'probe.runner', kind: 'step', measure: 'S3', minRung: 'R2', below: 'x' })
    const run = step.runner(keys, { door: 'routine' })
    await run({ prompt: 'a' })
    await run({ prompt: 'b' })
    expect(callLlmMock.mock.calls.map((c) => (c[1] as { name: string }).name)).toEqual(['probe.runner', 'probe.runner'])
    expect(callLlmMock.mock.calls.map((c) => (c[1] as { door: string }).door)).toEqual(['routine', 'routine'])
  })

  it('refuses a definition that names no measure, an unknown one, or no below sentence', () => {
    const base = { id: 'probe.bad', kind: 'step' as const, minRung: 'R2' as const }
    expect(() => defineModelStep({ ...base, measure: '', below: 'x' })).toThrow(/measure/)
    expect(() => defineModelStep({ ...base, measure: 'X99', below: 'x' })).toThrow(/measure/)
    expect(() => defineModelStep({ ...base, measure: 'S3', below: ' ' })).toThrow(/below/)
    expect(() => defineModelStep({ ...base, measure: 'S3', below: 'x', legacy: { retiredBy: '' } })).toThrow(/retires/)
  })

  it('checks the reply against its output schema and its code check', async () => {
    const shaped = defineModelStep({
      id: 'probe.shaped',
      kind: 'step',
      measure: 'S3',
      minRung: 'R2',
      below: 'x',
      outputSchema: z.object({ ok: z.literal(true) }),
    })
    expect((await shaped.call(keys, { prompt: 'x' })).parsed).toEqual({ ok: true })

    callLlmMock.mockResolvedValueOnce({ content: 'not json', model: 'm', tokensUsed: 1, promptTokens: 1, completionTokens: 0 })
    await expect(shaped.call(keys, { prompt: 'x' })).rejects.toBeInstanceOf(StepOutputError)

    const checked = defineModelStep({
      id: 'probe.checked',
      kind: 'step',
      measure: 'S3',
      minRung: 'R2',
      below: 'x',
      check: (content) => (content.includes('ok') ? 'the reply may not say ok' : null),
    })
    await expect(checked.call(keys, { prompt: 'x' })).rejects.toThrow(/may not say ok/)
  })
})

describe('the declared steps', () => {
  it('names a measure and a below sentence on every step in the registry', () => {
    for (const step of [chanceStep, inboxClassifyStep, embedStep, ...Object.values(LEGACY_STEPS)]) {
      expect(step.meta.measure, step.id).toMatch(/^[TSP]\d+$/)
      expect(step.meta.below.length, step.id).toBeGreaterThan(5)
    }
  })

  it('has a legacy step for every agent unit generation name, so a new unit cannot ship unnamed', () => {
    // Read from the source rather than imported: lib/graph/unit pulls in the whole agent registry.
    const unit = readFileSync(path.resolve(__dirname, '../graph/unit.ts'), 'utf8')
    const block = unit.match(/UNIT_GENERATION_NAME: Record<UnitType, string> = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const names = [...block.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1])
    expect(names.length).toBe(16)
    for (const name of names) expect(() => legacyStep(name), name).not.toThrow()
  })

  it('names the package that retires each legacy step', () => {
    for (const step of Object.values(LEGACY_STEPS)) expect(step.meta.legacy?.retiredBy, step.id).toMatch(/^K\d+/)
  })

  it('throws for a name nobody declared', () => {
    expect(() => legacyStep('made-up-name')).toThrow()
  })
})
