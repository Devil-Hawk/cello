import { describe, expect, it } from 'vitest'
import { companiesGet } from './directory'

const EMP = '00000000-0000-4000-8000-0000000000e1'

const employer = (over: Record<string, unknown> = {}) => ({ id: EMP, name: 'Stripe', domain: 'stripe.com', logo_url: null, open_count: 636, cannot_read_reason: null, ...over })

/** An admin client that answers by table: the directory row, the count of kept roles, and the person's followed rows. */
function ctx(tables: { company_directory: unknown; kept?: number; companies?: unknown[] }) {
  const chain = (table: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop: string) => {
        if (prop === 'then') {
          const result = table === 'company_directory' ? { data: tables.company_directory } : table === 'person_roles' ? { count: tables.kept ?? 0 } : { data: tables.companies ?? [] }
          return (res: (v: unknown) => unknown) => res({ error: null, ...result })
        }
        return () => chain(table)
      },
    })
  return { userId: 'u1', admin: () => ({ from: chain }) } as never
}

describe('companies.get', () => {
  it('gives the open count, the roles kept and whether the person follows', async () => {
    const out = await companiesGet.run(ctx({ company_directory: employer(), kept: 3, companies: [{ id: 'c1' }] }), { id: EMP })
    expect(out).toEqual({ id: EMP, name: 'Stripe', domain: 'stripe.com', logo_url: null, open: 636, kept: 3, following: true, cannot_read: null })
  })

  it('has no open count for an employer Cello cannot read, and says why', async () => {
    const out = await companiesGet.run(ctx({ company_directory: employer({ cannot_read_reason: 'no_board' }) }), { id: EMP })
    expect(out.open).toBeNull()
    expect(out.cannot_read).toBe('no_board')
    expect(out.following).toBe(false)
    expect(out.kept).toBe(0)
  })

  it('refuses an employer that is not in the directory', async () => {
    await expect(companiesGet.run(ctx({ company_directory: null }), { id: EMP })).rejects.toThrow('Cello does not have that employer.')
  })
})
