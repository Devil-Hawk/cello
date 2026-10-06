import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { ChoiceLimits } from '@/lib/models/choice'
import { describeRungs, readSettings, writeSettings } from './settings'

const FREE = 'qwen/qwen3.8-27b:free'
const limits = (over: Partial<ChoiceLimits> = {}): ChoiceLimits => ({ ceiling: 'R3', available: ['R3'], route: () => FREE, effort: 'low', ...over })
const seed = () =>
  makeFakeAdmin({
    chats: [
      { id: 'c1', user_id: 'u1', model_choice: null, settings: {} },
      { id: 'c2', user_id: 'u2', model_choice: null, settings: {} },
    ],
    profiles: [{ id: 'u1', preferences: { api_keys: { x: 'kept' } } }],
  })

describe('writeSettings', () => {
  it('refuses a choice above the person\'s highest and stores nothing', async () => {
    const db = seed()
    const done = await writeSettings(db, 'u1', 'c1', { choice: { rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'medium' } }, limits())
    expect(done).toMatchObject({ ok: false, error: 'That is above the highest model you allow.' })
    expect(db.tables.chats[0].model_choice).toBeNull()
  })

  it('never lets a paid id reach a free rung', async () => {
    const db = seed()
    const done = await writeSettings(db, 'u1', 'c1', { choice: { rung: 'R3', model: 'anthropic/claude-opus-4.8', effort: 'low' } }, limits({ ceiling: 'R4' }))
    expect(done).toMatchObject({ ok: false })
    expect(db.tables.chats[0].model_choice).toBeNull()
  })

  it('keeps the choice on the chat and, when asked, as the default for new chats without losing other preferences', async () => {
    const db = seed()
    const choice = { rung: 'R3', model: FREE, effort: 'medium' }
    expect(await writeSettings(db, 'u1', 'c1', { choice, review: true, tools_off: ['people', 'people'], as_default: true }, limits())).toEqual({ ok: true })
    expect(db.tables.chats[0].model_choice).toEqual(choice)
    expect(db.tables.chats[0].settings).toEqual({ review: true, tools_off: ['people'] })
    expect(db.tables.profiles[0].preferences).toEqual({ api_keys: { x: 'kept' }, chat_choice: choice })
  })

  it('stores a default with no chat, keeps other preferences, and refuses one above the highest', async () => {
    const db = seed()
    const choice = { rung: 'R3', model: FREE, effort: 'low' }
    expect(await writeSettings(db, 'u1', null, { choice, as_default: true }, limits())).toEqual({ ok: true })
    expect(db.tables.profiles[0].preferences).toEqual({ api_keys: { x: 'kept' }, chat_choice: choice })
    const above = { rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'medium' }
    expect(await writeSettings(db, 'u1', null, { choice: above, as_default: true }, limits())).toMatchObject({ ok: false })
    expect(db.tables.profiles[0].preferences).toEqual({ api_keys: { x: 'kept' }, chat_choice: choice })
    expect(await writeSettings(db, 'u1', null, { review: true }, limits())).toMatchObject({ ok: false })
  })

  it('refuses an unknown tool group and another person\'s chat', async () => {
    const db = seed()
    expect(await writeSettings(db, 'u1', 'c1', { tools_off: ['send_everything'] }, limits())).toMatchObject({ ok: false })
    expect(await writeSettings(db, 'u1', 'c2', { review: true }, limits())).toEqual({ ok: false, notFound: true })
    expect(db.tables.chats[1].settings).toEqual({})
  })
})

describe('readSettings', () => {
  it('says how a stored choice that cannot run will run, and greys the rungs that cannot be picked', async () => {
    const db = seed()
    db.tables.chats[0].model_choice = { rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'high' }
    const view = await readSettings(db, 'u1', 'c1', limits(), [FREE])
    expect(view?.ran).toMatchObject({ rung: 'R3', model: FREE, steppedDown: { why: 'above_highest' } })
    expect(view?.rungs.map((r) => [r.rung, r.why])).toEqual([
      ['R2', 'Not set up.'],
      ['R3', ''],
      ['R4', 'Above your highest. Change in Settings.'],
    ])
  })

  it('is null for another person\'s chat', async () => {
    expect(await readSettings(seed(), 'u1', 'c2', limits())).toBeNull()
  })

  it('names the free models by what they are called', () => {
    expect(describeRungs(limits(), [FREE])[1].models).toEqual([{ id: FREE, label: 'qwen3.8-27b' }])
  })
})
