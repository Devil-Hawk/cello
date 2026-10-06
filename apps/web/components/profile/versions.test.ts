import { describe, expect, it } from 'vitest'
import { deleteRefusal, versionLabel, type VersionRow } from './versions'

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
