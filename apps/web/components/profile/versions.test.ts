import { describe, expect, it } from 'vitest'
import { compareWith, deleteRefusal, tailorTargets, versionLabel, type VersionRow } from './versions'

const v = (over: Partial<VersionRow> = {}): VersionRow => ({
  id: 'v1',
  user_id: 'u',
  job_id: null,
  draft_id: null,
  version: 1,
  title: null,
  content: 'x',
  content_json: null,
  ats_score: null,
  source: 'base',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  role: null,
  sent: null,
  ...over,
})

describe('versionLabel', () => {
  it('never shows a file name', () => {
    for (const name of ['Jordan Resume.pdf', 'cv_final.DOCX', 'scan.jpeg', 'notes.md']) {
      expect(versionLabel(v({ title: name }))).toBe('Base resume')
    }
  })

  it('names a tailored version by role and company, with its title first', () => {
    const role = { title: 'Senior Backend Engineer', company: 'Northwind Atlas' }
    expect(versionLabel(v({ job_id: 'j', role }))).toBe('For Senior Backend Engineer at Northwind Atlas')
    expect(versionLabel(v({ job_id: 'j', role, title: 'Data Platform' }))).toBe('Data Platform, for Senior Backend Engineer at Northwind Atlas')
  })

  it('adds the day it was sent, with the company, to a sent version', () => {
    const label = versionLabel(
      v({ title: 'Data Platform', job_id: 'j', role: { title: 'Senior Backend Engineer', company: 'Northwind Atlas' }, sent: { at: '2026-10-04T15:00:00Z', company: 'Northwind Atlas' } })
    )
    expect(label).toBe('Data Platform, for Senior Backend Engineer at Northwind Atlas, sent Oct 4')
  })
})

describe('compareWith', () => {
  const b1 = v({ id: 'b1', version: 1 })
  const b2 = v({ id: 'b2', version: 2 })
  const t1 = v({ id: 't1', job_id: 'j', version: 1 })
  const all = [t1, b2, b1]

  it('compares a tailored version with the newest base', () => {
    expect(compareWith(t1, all)?.id).toBe('b2')
  })

  it('compares a base version with the one before it, and the first with nothing', () => {
    expect(compareWith(b2, all)?.id).toBe('b1')
    expect(compareWith(b1, all)).toBeNull()
  })

  it('has nothing to compare a tailored version with when there is no base', () => {
    expect(compareWith(t1, [t1])).toBeNull()
  })
})

describe('tailorTargets', () => {
  const tailored = v({ id: 't2', job_id: 'j2', version: 2, role: { title: 'Data Engineer', company: 'Acme' } })

  it('lists applications and keeps a role that only has a version, tailored first', () => {
    const out = tailorTargets([{ jobId: 'j1', title: 'Backend Engineer', company: 'Northwind' }], [tailored])
    expect(out.map((t) => [t.jobId, t.tailoredVersion])).toEqual([
      ['j2', 2],
      ['j1', null],
    ])
  })

  it('lists a role once and stops at the limit', () => {
    const apps = Array.from({ length: 30 }, (_, i) => ({ jobId: `a${i}`, title: 't', company: null }))
    expect(tailorTargets([...apps, { jobId: 'a0', title: 'again', company: null }], [])).toHaveLength(20)
    expect(tailorTargets([{ jobId: 'j2', title: 'Data Engineer', company: 'Acme' }], [tailored])).toHaveLength(1)
  })
})

describe('deleteRefusal', () => {
  it('refuses a sent version and names the company', () => {
    expect(deleteRefusal(v({ id: 'a', sent: { at: '2026-10-04T00:00:00Z', company: 'Northwind Atlas' } }), null)).toBe(
      'This version was sent to Northwind Atlas. It stays with that application.'
    )
  })

  it('refuses the current base and not an older one', () => {
    expect(deleteRefusal(v({ id: 'base2' }), 'base2')).toBe('This is your base resume. Edit it to make a new version.')
    expect(deleteRefusal(v({ id: 'base1' }), 'base2')).toBeNull()
  })

  it('allows an unsent tailored version', () => {
    expect(deleteRefusal(v({ id: 't', job_id: 'j' }), 'base2')).toBeNull()
  })
})
