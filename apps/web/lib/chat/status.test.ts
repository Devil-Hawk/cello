import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { readStatusLines } from './status'

const seed = () =>
  makeFakeAdmin({
    pipeline_events: [
      { id: 'e1', user_id: 'u1', application_id: 'a1', sentence: 'Cello is filling the form for Vantage Loom.', to_state: 'applying', created_at: '2026-10-05T10:00:00Z' },
      { id: 'e2', user_id: 'u2', application_id: 'a9', sentence: 'Someone else\'s line.', to_state: 'sent', created_at: '2026-10-05T10:00:00Z' },
      { id: 'e3', user_id: 'u1', application_id: null, sentence: 'No application.', to_state: null, created_at: '2026-10-05T10:00:00Z' },
    ],
  })

describe('readStatusLines', () => {
  it('reads the sentence from the event row, for this person only', async () => {
    const lines = await readStatusLines(seed(), 'u1', ['e1', 'e2', 'e3', 'missing'])
    expect(Object.keys(lines)).toEqual(['e1'])
    expect(lines.e1).toMatchObject({ sentence: 'Cello is filling the form for Vantage Loom.', applicationId: 'a1', state: 'applying' })
  })

  it('finds nothing, and does not fail, when there are no events or no pipeline yet', async () => {
    expect(await readStatusLines(seed(), 'u1', [])).toEqual({})
    expect(await readStatusLines(makeFakeAdmin({}), 'u1', ['e1'])).toEqual({})
  })
})
