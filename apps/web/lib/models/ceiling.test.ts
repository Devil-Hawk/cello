// The Ceiling set (blueprint 11.1): "Highest Cello may use" is enforced at both model
// doors, nothing climbs above it, a missing rung is never made up, and the person's
// order wins. No network: the one provider call is mocked and chat models are only built.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedApiKeys } from '../harness/types'

const reserveSpendMock = vi.fn()
vi.mock('../harness/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/spend')>()),
  reserveSpend: (...args: unknown[]) => reserveSpendMock(...args),
  settleSpend: vi.fn(),
}))
const callOpenRouterMock = vi.fn()
vi.mock('../harness/providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))
vi.mock('../harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

import { callLlm } from '../harness/llm'
import type { PersonModels, Rung, StepRef } from './doors.types'
import { CeilingError, chatModelFor } from './factory'
import { availableRungs, pickRung, personModels } from './ladder'

const PAID = 'anthropic/claude-sonnet-5'
const FREE = 'qwen/qwen3.8-27b:free'
const person = (ceiling: PersonModels['ceiling'], order: Rung[] = ['R4', 'R3', 'R2', 'R1']): PersonModels => ({ ceiling, order, creditBought: false })
const withModels = (keys: DecryptedApiKeys, models: PersonModels): DecryptedApiKeys => ({ ...keys, models })
const step = (minRung: Rung): StepRef => ({ id: 'chance', minRung, below: 'Roles are ordered by title match and date.' })

const LOCAL: DecryptedApiKeys['provider'] = {
  active: 'local-server',
  localCli: 'claude',
  localServerBaseUrl: 'http://localhost:11434/v1',
  localServerModel: 'llama3.1',
  localServerEmbeddingModel: '',
}

beforeEach(() => {
  reserveSpendMock.mockReset()
  callOpenRouterMock.mockReset()
  vi.stubEnv('VERCEL', '')
  vi.stubEnv('CELLO_SELF_HOSTED', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('both model doors refuse a paid model below R4', () => {
  it('callLlm refuses a paid id before anything is reserved or sent', async () => {
    const keys = withModels({ openrouter: 'k', userId: 'user-1' }, person('R3'))
    await expect(callLlm(keys, { prompt: 'hi', model: PAID })).rejects.toBeInstanceOf(CeilingError)
    expect(reserveSpendMock).not.toHaveBeenCalled()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
  })

  it('callLlm lets a free id through, and a paid id once the ceiling is R4', async () => {
    callOpenRouterMock.mockResolvedValue({ content: 'ok', tokensUsed: 2, promptTokens: 1, completionTokens: 1, model: FREE })
    await callLlm(withModels({ openrouter: 'k' }, person('R3')), { prompt: 'hi', model: FREE })
    await callLlm(withModels({ openrouter: 'k' }, person('R4')), { prompt: 'hi', model: PAID })
    expect(callOpenRouterMock).toHaveBeenCalledTimes(2)
  })

  it('chatModelFor refuses a paid id the same way, and the direct OpenAI and Anthropic keys with it', () => {
    const keys = withModels({ openrouter: 'k', openai: 'k', anthropic: 'k' }, person('R3'))
    expect(() => chatModelFor('openrouter', PAID, keys)).toThrow(CeilingError)
    expect(() => chatModelFor('openai', 'gpt-5.2', keys)).toThrow(CeilingError)
    expect(() => chatModelFor('anthropic', 'claude-sonnet-5', keys)).toThrow(CeilingError)
    expect(() => chatModelFor('openrouter', FREE, keys)).not.toThrow()
  })

  it('a call whose keys carry no ceiling (a script, an operator key) is not limited here', () => {
    expect(() => chatModelFor('openrouter', PAID, { openrouter: 'k' })).not.toThrow()
  })
})

describe('pickRung', () => {
  it('never climbs: a missing R3 does not become R4', () => {
    const keys = withModels({ openai: 'k' }, person('R3'))
    expect(pickRung(step('R2'), keys.models as PersonModels, availableRungs(keys), keys)).toMatchObject({ rung: null, reason: 'none_available' })
  })

  it('a step whose lowest rung is above the ceiling gets rung null and its own sentence', () => {
    const keys = withModels({ openrouter: 'k' }, person('R1'))
    expect(pickRung(step('R2'), keys.models as PersonModels, availableRungs(keys), keys)).toEqual({
      rung: null,
      reason: 'none_available',
      sentence: 'Roles are ordered by title match and date.',
    })
  })

  it('the person order wins among the rungs that are set up', () => {
    const keys: DecryptedApiKeys = { openrouter: 'k' }
    const available = availableRungs(keys, 'R4')
    expect(available).toEqual(['R0', 'R3', 'R4'])
    expect(pickRung(step('R2'), person('R4', ['R3', 'R4']), available, keys)).toMatchObject({ rung: 'R3', via: 'openrouter', model: FREE })
    expect(pickRung(step('R2'), person('R4', ['R4', 'R3']), available, keys)).toMatchObject({ rung: 'R4', via: 'openrouter', model: PAID })
  })

  it('R2 comes only from a self-hosted instance, never hosted', () => {
    const keys: DecryptedApiKeys = { provider: LOCAL }
    expect(availableRungs(keys, 'R4')).toEqual(['R0']) // not self-hosted
    vi.stubEnv('CELLO_SELF_HOSTED', '1')
    expect(availableRungs(keys, 'R4')).toEqual(['R0', 'R2'])
    vi.stubEnv('VERCEL', '1') // Vercel is a hard veto
    expect(availableRungs(keys, 'R4')).toEqual(['R0'])
  })

  it('R1 and hosted R2 are never offered, and are never picked if handed in', () => {
    const keys: DecryptedApiKeys = { openrouter: 'k' }
    expect(availableRungs(keys, 'R4')).not.toContain('R1')
    expect(pickRung(step('R1'), person('R4'), ['R0', 'R0s', 'R1'], keys)).toMatchObject({ rung: null })
  })

  it('R4 needs a key and a ceiling of R4', () => {
    expect(availableRungs({}, 'R4')).toEqual(['R0'])
    expect(availableRungs({ anthropic: 'k' }, 'R3')).toEqual(['R0'])
    expect(availableRungs({ anthropic: 'k' }, 'R4')).toEqual(['R0', 'R4'])
    const keys: DecryptedApiKeys = { anthropic: 'k', model: 'anthropic/claude-opus-4.8' }
    expect(pickRung(step('R2'), person('R4'), availableRungs(keys, 'R4'), keys)).toMatchObject({ rung: 'R4', via: 'anthropic', model: 'claude-opus-4-8' })
  })
})

describe('the default ceiling', () => {
  it('is the highest rung with no cost that is set up', () => {
    expect(personModels({ openrouter: 'k' }, {}).ceiling).toBe('R3')
    expect(personModels({}, {}).ceiling).toBe('R0')
    vi.stubEnv('CELLO_SELF_HOSTED', '1')
    expect(personModels({ provider: LOCAL }, {}).ceiling).toBe('R2')
    expect(personModels({ openrouter: 'k', provider: LOCAL }, {}).ceiling).toBe('R3')
  })

  it('stays R4 for a person who already chose a paid model, so nothing they pay for stops', () => {
    expect(personModels({ openrouter: 'k', model: PAID }, {}).ceiling).toBe('R4')
    expect(personModels({ openrouter: 'k', model: FREE }, {}).ceiling).toBe('R3')
  })

  it('reads what the person saved, and credit_bought from the pipeline', () => {
    const saved = { models: { ceiling: 'R2', order: ['R2', 'R3', 'nonsense'] }, pipeline: { credit_bought: true } }
    expect(personModels({ openrouter: 'k' }, saved)).toEqual({ ceiling: 'R2', order: ['R2', 'R3'], creditBought: true })
  })

  it('gives a demo the paid ceiling its capped allowance has always had', () => {
    expect(personModels({ openrouter: 'k' }, {}, true).ceiling).toBe('R4')
  })
})
