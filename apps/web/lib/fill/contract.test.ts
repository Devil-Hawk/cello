import { describe, expect, it } from 'vitest'
import { FieldList, FillNext, FillReport, FillValues, PHASES, STOP_CAUSES, readBackFor } from './contract'

const base = { application_id: 'a1', final_url: 'https://boards.example/acme/jobs/1' }
const name = { key: 'first_name', kind: 'text' as const, category: 'name' as const, entry: { value: 'Dana' } }

describe('FillReport', () => {
  it('every phase parses with what it needs', () => {
    const confirmation = { text: 'Thank you for applying', url: 'https://boards.example/acme/confirmation', seen_at: '2026-10-06T09:41:00Z' }
    const made: Record<(typeof PHASES)[number], object> = {
      filled: { phase: 'filled' },
      blocked: { phase: 'blocked', cause: 'site_check' },
      ready_to_send: { phase: 'ready_to_send', values: [name] },
      submitted: { phase: 'submitted', values: [name] },
      confirmation: { phase: 'confirmation', confirmation },
      unconfirmed: { phase: 'unconfirmed' },
      abandoned: { phase: 'abandoned' },
    }
    for (const phase of PHASES) expect(FillReport.safeParse({ ...base, ...made[phase] }).success, phase).toBe(true)
  })

  it('refuses a phase it does not know, and a blocked form that does not say why', () => {
    expect(FillReport.safeParse({ ...base, phase: 'sent' }).success).toBe(false)
    expect(FillReport.safeParse({ ...base, phase: 'blocked' }).success).toBe(false)
    expect(FillReport.safeParse({ ...base, phase: 'blocked', cause: 'on_fire' }).success).toBe(false)
    for (const cause of STOP_CAUSES) expect(FillReport.safeParse({ ...base, phase: 'blocked', cause }).success, cause).toBe(true)
  })

  it('a confirmation must carry what the site showed', () => {
    expect(FillReport.safeParse({ ...base, phase: 'confirmation' }).success).toBe(false)
  })

  it('refuses a password, a hidden input or a challenge in the values that were read back', () => {
    for (const kind of ['password', 'hidden', 'challenge'] as const) {
      const r = FillReport.safeParse({ ...base, phase: 'submitted', values: [name, { key: 'x', kind, entry: { value: 'secret' } }] })
      expect(r.success, kind).toBe(false)
    }
  })

  it('records a sensitive answer only as answered by the person, and a file only by name', () => {
    for (const category of ['work_auth', 'sponsorship', 'salary', 'eeo', 'consent'] as const) {
      const leaked = { key: 'q', kind: 'radio' as const, category, entry: { value: 'Yes' } }
      const safe = { key: 'q', kind: 'radio' as const, category, entry: { answered_by_you: true as const } }
      expect(FillReport.safeParse({ ...base, phase: 'submitted', values: [leaked] }).success, category).toBe(false)
      expect(FillReport.safeParse({ ...base, phase: 'submitted', values: [safe] }).success, category).toBe(true)
    }
    expect(FillReport.safeParse({ ...base, phase: 'submitted', values: [{ key: 'cv', kind: 'file', entry: { file_name: 'dana-lee.pdf' } }] }).success).toBe(true)
    expect(FillReport.safeParse({ ...base, phase: 'submitted', values: [{ key: 'cv', kind: 'file', entry: { value: 'bytes' } }] }).success).toBe(false)
  })
})

describe('the read-back allowlist', () => {
  it('names what may be recorded for each kind of field', () => {
    expect(readBackFor({ kind: 'text', category: 'name' })).toBe('value')
    expect(readBackFor({ kind: 'text' })).toBe('value')
    expect(readBackFor({ kind: 'radio', category: 'eeo' })).toBe('answered_by_you')
    expect(readBackFor({ kind: 'file' })).toBe('file_name')
    expect(readBackFor({ kind: 'password' })).toBe('never')
    expect(readBackFor({ kind: 'challenge' })).toBe('never')
  })
})

describe('the other shapes', () => {
  it('a field list needs a url and fields with a kind', () => {
    const ok = { application_id: 'a1', url: 'https://boards.example/acme/jobs/1', fields: [{ key: 'q1', label: 'First name', kind: 'text', required: true }] }
    expect(FieldList.safeParse(ok).success).toBe(true)
    expect(FieldList.safeParse({ ...ok, fields: [{ key: 'q1', label: 'x', kind: 'slider', required: true }] }).success).toBe(false)
  })

  it('values default to no unknown fields, and next is one application or none', () => {
    expect(FillValues.parse({ application_id: 'a1', values: { q1: 'Dana' } }).unknown).toEqual([])
    expect(FillNext.safeParse({ application: null }).success).toBe(true)
    expect(FillNext.safeParse({ application: { id: 'a1', url: 'https://boards.example/acme/jobs/1' } }).success).toBe(true)
    expect(FillNext.safeParse({ application: { id: 'a1' } }).success).toBe(false)
  })
})
