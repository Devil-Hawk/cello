import { describe, expect, it } from 'vitest'
import { readBack } from './readback'
import type { Snapshot } from './readback'

const snap = (over: Partial<Snapshot>): Snapshot => ({
  key: 'k',
  type: 'text',
  name: 'k',
  label: 'Field',
  value: '',
  checked: false,
  challenge: false,
  ...over,
})

describe('read-back allowlist', () => {
  it('reports plain answers by value', () => {
    expect(readBack([snap({ key: 'first_name', value: 'Ada' }), snap({ key: 'marketing_updates', type: 'checkbox', label: 'Send me updates', checked: true })])).toEqual({
      first_name: 'Ada',
      marketing_updates: true,
    })
  })

  it('drops password, hidden and challenge inputs entirely', () => {
    const out = readBack([
      snap({ key: 'pw', type: 'password', value: 'hunter2' }),
      snap({ key: 'token', type: 'hidden', value: 'abc' }),
      snap({ key: 'g-recaptcha-response', value: 'xyz', challenge: true }),
    ])
    expect(out).toEqual({})
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('reports sensitive, EEO and consent answers only as answered', () => {
    const out = readBack([
      snap({ key: 'gender', type: 'select', label: 'Gender', value: 'Woman' }),
      snap({ key: 'sponsor', label: 'Will you require sponsorship?', value: 'Yes' }),
      snap({ key: 'terms', type: 'checkbox', label: 'I agree to the privacy policy', checked: true }),
      snap({ key: 'cat', label: 'Anything', value: 'x', category: 'eeo' }),
    ])
    expect(out).toEqual({
      gender: { answered_by_you: true },
      sponsor: { answered_by_you: true },
      terms: { answered_by_you: true },
      cat: { answered_by_you: true },
    })
    expect(JSON.stringify(out)).not.toContain('Woman')
  })

  it('reports a file by the name Cello attached, and nothing else', () => {
    expect(readBack([snap({ key: 'resume', type: 'file', attachedName: 'Ada-Lovelace.pdf' })])).toEqual({
      resume: { file: 'Ada-Lovelace.pdf' },
    })
    expect(readBack([snap({ key: 'resume', type: 'file' })])).toEqual({})
  })

  it('leaves out empty answers and unticked sensitive boxes', () => {
    expect(readBack([snap({ key: 'x', value: '  ' }), snap({ key: 'terms', type: 'checkbox', label: 'I agree', checked: false })])).toEqual({})
  })
})
