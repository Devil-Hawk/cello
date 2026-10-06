import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))

import JobsRedirect from './page'

const go = (searchParams: { job?: string | string[] }) => {
  try {
    JobsRedirect({ searchParams })
  } catch (e) {
    return (e as Error).message
  }
  return 'no redirect'
}

describe('/jobs', () => {
  it('opens Roles, and a role linked by id opens its record', () => {
    expect(go({})).toBe('redirect:/roles')
    expect(go({ job: '10000000-0000-4000-8000-000000000001' })).toBe('redirect:/roles/10000000-0000-4000-8000-000000000001')
    expect(go({ job: ['10000000-0000-4000-8000-000000000001', 'x'] })).toBe('redirect:/roles/10000000-0000-4000-8000-000000000001')
  })

  it('does not carry anything that is not a role id into the address', () => {
    expect(go({ job: '../../settings' })).toBe('redirect:/roles')
    expect(go({ job: 'x' })).toBe('redirect:/roles')
  })
})
