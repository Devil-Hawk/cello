import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
const callTool = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agents/user-mcp', () => ({ callUserMcpTool: callTool }))

import { mcpTargets } from './mcp-confirm'
import { ApplyRefusal, confirmProposal, dismissProposal, propose, renderProposal, type ApplyTargets } from './proposals'

const CHAT = '00000000-0000-4000-8000-000000000900'
const ROLE = '00000000-0000-4000-8000-000000000001'
const room = () =>
  makeFakeAdmin(
    {
      chat_turns: [
        { id: 't1', user_id: 'u1', chat_id: CHAT, kind: 'person', typed: 'Please stop showing crypto roles to me', superseded_at: null },
        // Cello's own words and a quoted selection are never the person's words.
        { id: 't2', user_id: 'u1', chat_id: CHAT, kind: 'cello', typed: null, answer: 'you said you hate agencies', superseded_at: null },
        { id: 't3', user_id: 'u1', chat_id: CHAT, kind: 'person', typed: 'do that', quoted: { text: 'hide every staffing agency', turn_id: 't2' }, superseded_at: null },
      ],
      proposals: [],
    },
    // The database's own default.
    { proposals: { defaults: () => ({ status: 'open' }) } }
  )
const base = { chatId: CHAT, turnId: 't1' }
const all = (apply = vi.fn()): ApplyTargets => ({ search: apply, answers: apply, start: apply, material: apply, instructions: apply, learned: apply })
const search = { kind: 'search', payload: { exclude_keywords: ['crypto'] }, quote: 'stop showing crypto roles' }

describe('propose', () => {
  it('stores a proposal and renders its card from the payload', async () => {
    const db = room()
    const out = await propose(db, 'u1', { ...base, ...search }, all())
    expect(out).toMatchObject({ ok: true, card: 'Stop showing roles with: crypto' })
    expect(db.tables.proposals[0]).toMatchObject({ user_id: 'u1', kind: 'search', status: 'open', origin: 'model', prov: { turn_id: 't1' }, channel: 'chat', payload: { exclude_keywords: ['crypto'] } })
  })

  it('refuses unknown keys and the settings that are the person\'s alone', async () => {
    const db = room()
    for (const key of ['pipeline', 'following', 'watching', 'send', 'autonomy', 'surprise']) {
      const out = await propose(db, 'u1', { ...base, ...search, payload: { exclude_keywords: ['crypto'], [key]: true } }, all())
      expect(out.ok, key).toBe(false)
    }
    expect(db.tables.proposals).toHaveLength(0)
  })

  it('refuses a quote that is not in what the person typed', async () => {
    const db = room()
    expect(await propose(db, 'u1', { ...base, ...search, quote: 'you said you hate agencies' }, all())).toMatchObject({ ok: false })
    expect(await propose(db, 'u1', { ...base, kind: 'search', payload: { exclude_keywords: ['agency'] }, quote: 'hide every staffing agency' }, all())).toMatchObject({ ok: false })
    expect(await propose(db, 'u1', { ...base, ...search, quote: 'roles' }, all())).toMatchObject({ ok: false })
    expect(await propose(db, 'u1', { ...base, ...search, quote: undefined }, all())).toMatchObject({ ok: false })
    expect(await propose(db, 'u2', { ...base, ...search }, all())).toMatchObject({ ok: false })
  })

  it('refuses a kind whose command is not registered', async () => {
    const out = await propose(room(), 'u1', { ...base, ...search }, { answers: vi.fn() })
    expect(out).toMatchObject({ ok: false, error: 'Cello cannot apply that yet.' })
  })

  it('needs no typed quote for a start, but the ids must be well formed', async () => {
    const db = room()
    expect(await propose(db, 'u1', { ...base, kind: 'start', payload: { role_ids: [ROLE] } }, all())).toMatchObject({ ok: true, card: 'Start 1 role' })
    expect(await propose(db, 'u1', { ...base, kind: 'start', payload: { role_ids: ['x'] } }, all())).toMatchObject({ ok: false })
  })

  it('shows an instruction as its exact stored text', () => {
    expect(renderProposal('instructions', { text: 'Check my five fintechs', local_time: '08:00', every: 'day' })).toBe('Every day at 08:00: Check my five fintechs')
  })
})

describe('confirmProposal', () => {
  it('applies exactly the stored payload, once', async () => {
    const db = room()
    const apply = vi.fn()
    const made = await propose(db, 'u1', { ...base, ...search }, all(apply))
    if (!made.ok) throw new Error('propose failed')
    expect(await confirmProposal(db, 'u1', made.id, all(apply))).toEqual({ ok: true })
    expect(apply).toHaveBeenCalledWith(db, 'u1', { exclude_keywords: ['crypto'] }, made.id)
    expect(db.tables.proposals[0]).toMatchObject({ status: 'confirmed' })
    expect(db.tables.proposals[0].confirmed_at).toBeTruthy()
    expect(await confirmProposal(db, 'u1', made.id, all(apply))).toMatchObject({ ok: false })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('refuses a stored payload that carries a guarded key, and another person\'s proposal', async () => {
    const db = room()
    db.tables.proposals.push({ id: 'p1', user_id: 'u1', kind: 'search', payload: { exclude_keywords: ['x'], autonomy: 'full' }, status: 'open' })
    db.tables.proposals.push({ id: 'p2', user_id: 'u2', kind: 'search', payload: { exclude_keywords: ['x'] }, status: 'open' })
    const apply = vi.fn()
    expect(await confirmProposal(db, 'u1', 'p1', all(apply))).toMatchObject({ ok: false })
    expect(await confirmProposal(db, 'u1', 'p2', all(apply))).toMatchObject({ ok: false })
    expect(apply).not.toHaveBeenCalled()
  })

  it('gives the proposal back when the change fails, so Confirm can be tried again', async () => {
    const db = room()
    const made = await propose(db, 'u1', { ...base, ...search }, all())
    if (!made.ok) throw new Error('propose failed')
    const out = await confirmProposal(db, 'u1', made.id, all(vi.fn().mockRejectedValue(new Error('down'))))
    expect(out).toMatchObject({ ok: false })
    expect(db.tables.proposals[0]).toMatchObject({ status: 'open' })
  })

  it('dismisses an open proposal once', async () => {
    const db = room()
    const made = await propose(db, 'u1', { ...base, ...search }, all())
    if (!made.ok) throw new Error('propose failed')
    expect(await dismissProposal(db, 'u1', made.id)).toEqual({ ok: true })
    expect(await dismissProposal(db, 'u1', made.id)).toMatchObject({ ok: false })
  })
})

describe('an outside tool call', () => {
  const call = { kind: 'mcp', payload: { server: 'mail', tool: 'send_email', args: { to: 'a@b.co', body: 'x'.repeat(300), count: 2 } } }
  const only = (apply = vi.fn()): ApplyTargets => ({ mcp: apply })

  it('renders an outside tool call from the stored payload', async () => {
    const out = await propose(room(), 'u1', { ...base, ...call }, only())
    expect(out).toMatchObject({ ok: true, card: `Run "send_email" on mail with: to: a@b.co; body: ${'x'.repeat(300)}; count: 2` })
    const hostile = `${'A'.repeat(296)}HIDDEN-TAIL`
    expect(renderProposal('mcp', { server: 'mail', tool: 'send_email', args: { body: hostile, extra: { n: hostile } } })).toContain(`body: ${hostile}; extra: {"n":"${hostile}"}`)
    expect(renderProposal('mcp', { server: 'notes', tool: 'list', args: {} })).toBe('Run "list" on notes.')
  })

  it('needs no typed quote, and refuses an extra key, a guarded key or args over 4 KB', async () => {
    const db = room()
    expect(await propose(db, 'u1', { ...base, ...call }, only())).toMatchObject({ ok: true })
    expect(await propose(db, 'u1', { ...base, kind: 'mcp', payload: { ...call.payload, extra: 1 } }, only())).toMatchObject({ ok: false })
    expect(await propose(db, 'u1', { ...base, kind: 'mcp', payload: { ...call.payload, autonomy: 'full' } }, only())).toMatchObject({ ok: false })
    expect(await propose(db, 'u1', { ...base, kind: 'mcp', payload: { ...call.payload, args: { a: 'x'.repeat(4100) } } }, only())).toMatchObject({ ok: false })
    expect(db.tables.proposals).toHaveLength(1)
  })

  it('runs the stored call once on Confirm', async () => {
    const db = room()
    const apply = vi.fn()
    const made = await propose(db, 'u1', { ...base, ...call }, only(apply))
    if (!made.ok) throw new Error('propose failed')
    expect(await confirmProposal(db, 'u1', made.id, only(apply))).toEqual({ ok: true })
    expect(await confirmProposal(db, 'u1', made.id, only(apply))).toMatchObject({ ok: false })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(db, 'u1', call.payload, made.id)
  })

  it('refuses a stored payload with an extra key', async () => {
    const db = room()
    db.tables.proposals.push({ id: 'p1', user_id: 'u1', kind: 'mcp', payload: { ...call.payload, extra: 1 }, status: 'open' })
    const apply = vi.fn()
    expect(await confirmProposal(db, 'u1', 'p1', only(apply))).toMatchObject({ ok: false })
    expect(apply).not.toHaveBeenCalled()
  })

  it('reopens the proposal and returns the words of a refusal', async () => {
    const db = room()
    const made = await propose(db, 'u1', { ...base, ...call }, only())
    if (!made.ok) throw new Error('propose failed')
    const refusing = vi.fn().mockRejectedValue(new ApplyRefusal('Could not reach mail.', 'Try Confirm again.'))
    expect(await confirmProposal(db, 'u1', made.id, only(refusing))).toEqual({ ok: false, error: 'Could not reach mail.', fix: 'Try Confirm again.' })
    expect(db.tables.proposals[0]).toMatchObject({ status: 'open' })
  })

  describe('when the server is slow or drops the answer', () => {
    const mailCall = { kind: 'mcp', payload: { server: 'mail', tool: 'send_email', args: { to: 'a@b.co', body: 'hi' } } }
    const confirmWith = async (outcome: unknown) => {
      callTool.mockReset().mockResolvedValue(outcome)
      const db = room()
      db.tables.chats = [{ id: CHAT, user_id: 'u1', last_turn_at: null }]
      const made = await propose(db, 'u1', { ...base, ...mailCall }, mcpTargets({ chatId: CHAT, isDemo: false }))
      if (!made.ok) throw new Error('propose failed')
      return { db, id: made.id, targets: mcpTargets({ chatId: CHAT, isDemo: false }) }
    }
    const turns = (db: ReturnType<typeof room>) => db.tables.chat_turns.filter((t) => t.origin === 'code')

    it('keeps a timed out send confirmed, says so in one turn and offers no second Confirm', async () => {
      const { db, id, targets } = await confirmWith({ ok: false, unsure: true, reason: 'Cello did not get an answer from mail.', fix: 'The call may or may not have gone through. Check on the server before you try again.' })
      expect(await confirmProposal(db, 'u1', id, targets)).toEqual({ ok: true })
      expect(db.tables.proposals[0]).toMatchObject({ status: 'confirmed' })
      expect(turns(db)).toHaveLength(1)
      expect(turns(db)[0].answer).toContain('may or may not have gone through')
      // A second Confirm finds nothing open, so the server is not called again.
      expect(await confirmProposal(db, 'u1', id, targets)).toMatchObject({ ok: false })
      expect(callTool).toHaveBeenCalledTimes(1)
    })

    it('reopens the proposal when the call failed before it was sent', async () => {
      const { db, id, targets } = await confirmWith({ ok: false, reason: 'Could not reach mail.', fix: 'Try Confirm again.' })
      expect(await confirmProposal(db, 'u1', id, targets)).toEqual({ ok: false, error: 'Could not reach mail.', fix: 'Try Confirm again.' })
      expect(db.tables.proposals[0]).toMatchObject({ status: 'open' })
      expect(turns(db)).toHaveLength(0)
    })
  })
})
