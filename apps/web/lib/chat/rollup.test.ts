import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { writeRollup } from './rollup'

const task = (command: string, status: string, extra: Record<string, unknown> = {}) => ({ id: `${command}-${status}-${Math.random()}`, user_id: 'u1', chat_id: 'c1', turn_id: 't1', command, status, parent_id: null, ...extra })
const seed = (rows: ReturnType<typeof task>[]) =>
  makeFakeAdmin({
    chats: [{ id: 'c1', user_id: 'u1', last_turn_at: null }],
    chat_turns: [],
    agent_tasks: [task('chat.turn', 'working'), ...rows],
    chat_attachments: [
      { id: 'x1', user_id: 'u1', chat_id: 'c1', kind: 'application', ref: { id: 'app1' }, origin: 'model', prov: { turn_id: 't1' }, removed_at: null },
      { id: 'x2', user_id: 'u1', chat_id: 'c1', kind: 'application', ref: { id: 'app2' }, origin: 'model', prov: { turn_id: 't1' }, removed_at: null },
      { id: 'x3', user_id: 'u1', chat_id: 'c1', kind: 'application', ref: { id: 'app3' }, origin: 'model', prov: { turn_id: 'other' }, removed_at: null },
    ],
    applications: [
      { id: 'app1', user_id: 'u1', job_id: 'j1', state: 'needs_you', step: null, needs_reason: 'approve_resume', needs_detail: null },
      { id: 'app2', user_id: 'u1', job_id: 'j2', state: 'needs_you', step: null, needs_reason: 'answer', needs_detail: null },
      { id: 'app3', user_id: 'u1', job_id: 'j3', state: 'needs_you', step: null, needs_reason: 'answer', needs_detail: null },
    ],
    person_jobs: [
      { id: 'j1', viewer_id: 'u1', title: 'Forward Deployed Engineer', viewer_company_name: 'Ramp' },
      { id: 'j2', viewer_id: 'u1', title: 'AI Engineer', viewer_company_name: null },
      { id: 'j3', viewer_id: 'u1', title: 'Elsewhere', viewer_company_name: 'Nope' },
    ],
  })

describe('writeRollup', () => {
  it('says what was done and what needs you, from rows', async () => {
    const db = seed([task('applications.start', 'done'), task('applications.start', 'done'), task('documents.draft', 'done'), task('research', 'partial'), task('research', 'failed'), task('applications.start', 'stopped')])
    expect(await writeRollup(db, 'u1', 'c1', 't1')).toBe(true)
    const row = db.tables.chat_turns[0]
    expect(row).toMatchObject({ kind: 'cello', origin: 'code', prov: { step: 'chat', rule: 'rollup', turn_id: 't1' } })
    expect(row.parts).toEqual([
      { about: [], text: 'Done: 2 started, 1 drafted, 1 researched. 1 could not finish. 1 stopped by you.' },
      { about: [{ kind: 'application', ref: 'app1' }], text: 'Needs you: approve the tailored resume for [Forward Deployed Engineer at Ramp](cello:application/app1).' },
      { about: [{ kind: 'application', ref: 'app2' }], text: 'Needs you on [AI Engineer](cello:application/app2): a question Cello will not guess.' },
    ])
    expect(row.links).toEqual([
      { kind: 'application', table: 'applications', id: 'app1', role: 'named' },
      { kind: 'application', table: 'applications', id: 'app2', role: 'named' },
    ])
    expect(String(row.answer).split('\n\n')).toHaveLength(3)
    expect(db.tables.chats[0].last_turn_at).toBeTruthy()
  })

  it('writes nothing when there is nothing to say', async () => {
    const db = seed([])
    db.tables.chat_attachments = []
    expect(await writeRollup(db, 'u1', 'c1', 't1')).toBe(false)
    expect(db.tables.chat_turns).toHaveLength(0)
  })

  it('writes one rollup per turn', async () => {
    const db = seed([task('documents.draft', 'done'), task('other.thing', 'done'), task('other.thing', 'done')])
    expect(await writeRollup(db, 'u1', 'c1', 't1')).toBe(true)
    expect(await writeRollup(db, 'u1', 'c1', 't1')).toBe(false)
    expect(db.tables.chat_turns).toHaveLength(1)
    expect((db.tables.chat_turns[0].parts as { text: string }[])[0].text).toBe('Done: 1 drafted, finished 2 other tasks.')
  })

  it('says nothing finished when only failures are left', async () => {
    const db = seed([task('applications.start', 'failed')])
    db.tables.chat_attachments = []
    await writeRollup(db, 'u1', 'c1', 't1')
    expect((db.tables.chat_turns[0].parts as { text: string }[])[0].text).toBe('Done: nothing finished. 1 could not finish.')
  })

  it('does not count a row cut short by a dead request when its work ran again and finished', async () => {
    const db = seed([
      task('applications.start', 'failed', { summary: 'Interrupted. Cello picked this up again.', object: { kind: 'role', ref: 'j1' } }),
      task('applications.start', 'done', { object: { kind: 'role', ref: 'j1' } }),
      task('applications.start', 'failed', { summary: 'Interrupted. Cello picked this up again.', object: { kind: 'role', ref: 'j2' } }),
    ])
    db.tables.chat_attachments = []
    await writeRollup(db, 'u1', 'c1', 't1')
    // j1 ran again; j2 did not, so it still did not finish.
    expect((db.tables.chat_turns[0].parts as { text: string }[])[0].text).toBe('Done: 1 started. 1 could not finish.')
  })

  it('still asks for a stopped role whose application finished preparing and now waits for the person', async () => {
    const db = seed([task('applications.start', 'stopped', { object: { kind: 'role', ref: 'j1' } }), task('applications.start', 'done', { object: { kind: 'role', ref: 'j2' } })])
    await writeRollup(db, 'u1', 'c1', 't1')
    const parts = db.tables.chat_turns[0].parts as { text: string }[]
    expect(parts.map((p) => p.text)).toEqual([
      'Done: 1 started. 1 stopped by you.',
      'Needs you: approve the tailored resume for [Forward Deployed Engineer at Ramp](cello:application/app1).',
      'Needs you on [AI Engineer](cello:application/app2): a question Cello will not guess.',
    ])
  })

  it('does not ask for a stopped role whose application is paused', async () => {
    const db = seed([task('applications.start', 'stopped', { object: { kind: 'role', ref: 'j1' } }), task('applications.start', 'done', { object: { kind: 'role', ref: 'j2' } })])
    db.tables.applications.find((a) => a.id === 'app1')!.state = 'paused'
    await writeRollup(db, 'u1', 'c1', 't1')
    const parts = db.tables.chat_turns[0].parts as { text: string }[]
    expect(parts.map((p) => p.text)).toEqual(['Done: 1 started. 1 stopped by you.', 'Needs you on [AI Engineer](cello:application/app2): a question Cello will not guess.'])
  })
})
