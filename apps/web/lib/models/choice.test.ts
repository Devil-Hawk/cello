import { describe, expect, it } from 'vitest'
import { celloChatModel, estimateChoice, parseChoice, resolveChoice, validateChoice, type ChoiceLimits, type ModelChoice } from './choice'

const FREE = 'qwen/qwen3.8-27b:free'
const paid = (over: Partial<ModelChoice> = {}): ModelChoice => ({ rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'medium', ...over })
const free = (over: Partial<ModelChoice> = {}): ModelChoice => ({ rung: 'R3', model: FREE, effort: 'low', ...over })
const limits = (over: Partial<ChoiceLimits> = {}): ChoiceLimits => ({
  ceiling: 'R4',
  available: ['R3', 'R4'],
  route: (rung) => (rung === 'R4' ? 'anthropic/claude-sonnet-5' : rung === 'R3' ? FREE : 'local/model'),
  effort: 'medium',
  ...over,
})

describe('parseChoice', () => {
  it('takes exactly a rung, a model and an effort', () => {
    expect(parseChoice(paid())).toEqual(paid())
    expect(parseChoice({ ...paid(), extra: 1 })).toBeNull()
    expect(parseChoice({ ...paid(), rung: 'R9' })).toBeNull()
    expect(parseChoice({ ...paid(), effort: 'enormous' })).toBeNull()
    expect(parseChoice('R4')).toBeNull()
    expect(parseChoice(null)).toBeNull()
  })
})

describe('validateChoice (chat.settings)', () => {
  it('refuses a choice above the highest the person allows', () => {
    expect(validateChoice(paid(), 'R3')).toMatchObject({ ok: false, error: 'That is above the highest model you allow.' })
    expect(validateChoice(paid(), 'R0')).toMatchObject({ ok: false })
  })

  it('never lets a paid id reach a free rung, and refuses a model Cello does not offer', () => {
    expect(validateChoice(free({ model: 'anthropic/claude-sonnet-5' }), 'R3')).toMatchObject({ ok: false, error: 'That model is not free.' })
    expect(validateChoice(paid({ model: 'someone/unlisted-model' }), 'R4')).toMatchObject({ ok: false })
  })

  it('accepts a free choice at Free models and a listed paid one at the highest', () => {
    expect(validateChoice(free(), 'R3')).toEqual({ ok: true, choice: free() })
    expect(validateChoice(paid(), 'R4')).toEqual({ ok: true, choice: paid() })
  })
})

describe('resolveChoice', () => {
  it('takes the first usable candidate in order: turn, chat, person, default', () => {
    expect(resolveChoice([null, paid({ effort: 'high' }), free()], limits())).toEqual({ rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'high' })
    expect(resolveChoice([{ nonsense: true }, free()], limits())).toEqual({ rung: 'R3', model: FREE, effort: 'low' })
  })

  it('uses the highest rung that is set up when nothing was chosen', () => {
    expect(resolveChoice([null, undefined], limits())).toEqual({ rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'medium' })
    expect(resolveChoice([], limits({ ceiling: 'R3' }))).toEqual({ rung: 'R3', model: FREE, effort: 'medium' })
  })

  it('steps down from a choice above the highest, and records it', () => {
    const out = resolveChoice([paid()], limits({ ceiling: 'R3' }))
    expect(out).toEqual({ rung: 'R3', model: FREE, effort: 'medium', steppedDown: { wanted: paid(), why: 'above_highest' } })
  })

  it('steps down from a rung that is not set up, and records it', () => {
    const out = resolveChoice([paid()], limits({ available: ['R3'] }))
    expect(out).toMatchObject({ rung: 'R3', steppedDown: { why: 'not_set_up' } })
  })

  it('never runs a paid id on a free rung: the rung\'s own model runs and the swap is recorded', () => {
    const out = resolveChoice([free({ model: 'anthropic/claude-sonnet-5' })], limits())
    expect(out).toMatchObject({ rung: 'R3', model: FREE, steppedDown: { why: 'model' } })
  })

  it('returns null when nothing can run', () => {
    expect(resolveChoice([paid()], limits({ available: [] }))).toBeNull()
    expect(resolveChoice([paid()], limits({ ceiling: 'R0' }))).toBeNull()
  })
})

describe('estimateChoice', () => {
  const tokens = { prompt: 20_000, completion: 2_000 }
  it('says Free for a free or local rung', () => {
    expect(estimateChoice(free(), tokens)).toEqual({ known: true, usd: 0, text: 'Free' })
    expect(estimateChoice({ rung: 'R2', model: 'local/model' }, tokens)).toMatchObject({ known: true, usd: 0 })
  })

  it('prices a listed paid model and says so when a model has no listed price', () => {
    const listed = estimateChoice(paid(), tokens)
    expect(listed.known).toBe(true)
    expect(listed.usd).toBeCloseTo(0.06, 5)
    expect(listed.text).toBe('About $0.06')
    expect(estimateChoice(paid({ model: 'someone/unlisted-model' }), tokens)).toEqual({ known: false, usd: null, text: 'Cost not known before sending' })
    expect(estimateChoice(paid(), { prompt: 100, completion: 10 }).text).toBe('Under $0.01')
  })
})

describe('celloChatModel', () => {
  const keys = { openrouter: 'sk-test' }
  it('builds the model the choice names, and refuses a paid id on the free rung and the local rung', () => {
    expect((celloChatModel(free(), keys) as unknown as { model: string }).model).toBe(FREE)
    expect((celloChatModel(paid(), keys) as unknown as { model: string }).model).toBe('anthropic/claude-sonnet-5')
    expect(() => celloChatModel(free({ model: 'anthropic/claude-sonnet-5' }), keys)).toThrow('not free')
    expect(() => celloChatModel({ rung: 'R2', model: 'local/model' }, keys)).toThrow('This computer')
  })

  it('needs a key, like every other door', () => {
    expect(() => celloChatModel(paid(), {})).toThrow('No OpenRouter API key')
  })
})
