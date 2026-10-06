import { describe, expect, it } from 'vitest'
import { parseCompanyIds } from './company-ids'

const A = '0b1f6c2e-3b0a-4a7e-9a55-1d2f3a4b5c6d'
const B = '9c8b7a6d-5e4f-4321-8abc-0123456789ab'

describe('parseCompanyIds', () => {
  it('reads a comma list of ids, once each', () => {
    expect(parseCompanyIds(`${A},${B}`)).toEqual([A, B])
    expect(parseCompanyIds(` ${A} , ${A} `)).toEqual([A])
  })

  it('refuses empty text, a name that is not an id, and a list over 50', () => {
    expect(parseCompanyIds('')).toBeNull()
    expect(parseCompanyIds(`${A},retell`)).toBeNull()
    expect(parseCompanyIds(`${A}; drop table companies`)).toBeNull()
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(parseCompanyIds(many.join(','))).toBeNull()
    expect(parseCompanyIds(many.slice(0, 50).join(','))).toHaveLength(50)
  })
})
