// postings.read: one posting from a link the person typed, read live and never stored (T3, T21).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../define'
import { CommandRefusal } from '../define'

const preview = vi.hoisted(() => ({ previewPosting: vi.fn() }))
vi.mock('@/lib/companies/preview', () => preview)
const detect = vi.hoisted(() => ({ detectFromUrl: vi.fn() }))
vi.mock('@/lib/ats/detect', () => detect)

import { postingsRead } from './chat'

const URL_ = 'https://acme.example.com/careers/senior-engineer-123'
const writes = vi.fn()
const db = { from: () => ({ insert: writes, update: writes, upsert: writes, delete: writes }), rpc: writes }
const ctxFor = (typed: string) => ({ userId: 'u1', typed, admin: () => db }) as unknown as CommandContext

const posting = {
  title: 'Senior engineer',
  location: 'Remote, US',
  salary_range: '$150,000 to $180,000',
  description_md: 'x',
  description_state: 'full',
  description_source: 'site',
  apply_url: null,
  description_md5: 'abcdef0123456789abcdef0123456789',
  requirements: { items: [] as unknown[] },
}
const item = (kind: 'must' | 'nice', quote: string) => ({ id: quote, text: quote, kind, heading: 'Requirements', quote })

beforeEach(() => {
  vi.clearAllMocks()
  detect.detectFromUrl.mockReturnValue(null)
})

describe('postings.read', () => {
  it('reads a posting only from a link the person typed', async () => {
    await expect(postingsRead.run(ctxFor('what do you think of this role?'), { url: URL_ })).rejects.toMatchObject({
      status: 400,
      code: 'needs_typed',
      message: 'Cello reads a posting only from a link you typed in this message.',
    })
    await expect(postingsRead.run(ctxFor('hi'), { url: URL_ })).rejects.toBeInstanceOf(CommandRefusal)
    expect(preview.previewPosting).not.toHaveBeenCalled()

    preview.previewPosting.mockResolvedValue({
      ...posting,
      requirements: { items: [item('nice', '5+ years of Go'), item('must', 'Experience with Postgres')] },
    })
    const r = (await postingsRead.run(ctxFor(`read ${URL_} please`), { url: URL_ })) as { sentence: string; things: { id: string; title: string; place: string; pay: string; company: null; notes: string[] }[] }
    expect(preview.previewPosting).toHaveBeenCalledWith({ url: URL_ })
    expect(r.sentence).toBe('Read Senior engineer. It was read live and not stored.')
    expect(r.things).toHaveLength(1)
    expect(r.things[0]).toMatchObject({ kind: 'role', id: 'posting:abcdef0123456789', title: 'Senior engineer', company: null, place: 'Remote, US', pay: '$150,000 to $180,000' })
    // The musts come first, each in the posting's words, then where it was read from.
    expect(r.things[0].notes).toEqual(['Requirement: "Experience with Postgres"', 'Requirement: "5+ years of Go"', 'Read from acme.example.com'])
    expect(writes).not.toHaveBeenCalled()
  })

  it('cuts the notes to eleven requirements and the source line', async () => {
    preview.previewPosting.mockResolvedValue({ ...posting, requirements: { items: Array.from({ length: 20 }, (_, i) => item('must', `Need ${i}`)) } })
    const r = (await postingsRead.run(ctxFor(URL_), { url: URL_ })) as { things: { notes: string[] }[] }
    expect(r.things[0].notes).toHaveLength(12)
    expect(r.things[0].notes[11]).toBe('Read from acme.example.com')
  })

  it('answers a board link with the list-of-roles sentence and no things', async () => {
    const board = 'https://boards.greenhouse.io/acme'
    preview.previewPosting.mockResolvedValue(null)
    detect.detectFromUrl.mockReturnValue({ provider: 'greenhouse', token: 'acme' })
    const r = (await postingsRead.run(ctxFor(board), { url: board })) as { sentence: string; things: unknown[] }
    expect(r.sentence).toBe('That is a list of roles. Add it on Companies, under Find or add, and Cello reads it on its schedule.')
    expect(r.things).toEqual([])
    expect(writes).not.toHaveBeenCalled()
  })

  it('answers an unreadable page with the could-not-read sentence and no things', async () => {
    preview.previewPosting.mockResolvedValue(null)
    const r = (await postingsRead.run(ctxFor(URL_), { url: URL_ })) as { sentence: string; things: unknown[] }
    expect(r.sentence).toBe('Cello could not read that page as one posting. Check the link, or add the company on Companies.')
    expect(r.things).toEqual([])
    expect(writes).not.toHaveBeenCalled()
  })

  it('hashes the link when the posting has no body hash', async () => {
    preview.previewPosting.mockResolvedValue({ ...posting, description_md5: null })
    const r = (await postingsRead.run(ctxFor(URL_), { url: URL_ })) as { things: { id: string }[] }
    expect(r.things[0].id).toMatch(/^posting:[0-9a-f]{16}$/)
  })

  it('is a Chat-only command that takes typed words', () => {
    expect(postingsRead).toMatchObject({ id: 'postings.read', callers: ['chat'], kind: 'code', sends: false, egress: 'typed', needsTyped: true, measure: 'T21' })
  })
})
