import { describe, expect, it, vi } from 'vitest'
import { MODEL_LIMIT, newModelBudget } from './model'
import { runRequirementsPass, type PendingJob, type RequirementsRows } from './requirements-pass'
import { parseRequirements, type Requirements } from '../jobs/requirements'

const PROSE =
  'Own a quota selling to mid-market finance teams. Minimum 3 years closing B2B SaaS deals; comfortable with Salesforce. '.repeat(5)
const SPLIT = `About us\nWe build things.\n\nRequirements\n* SQL\n* Python\n\nNice to have\n* dbt\n\n${'More text about the team. '.repeat(20)}`

function job(id: string, description: string): PendingJob {
  return {
    id,
    title: 'Account Executive',
    description,
    location: null,
    salaryRange: null,
    requirements: parseRequirements({ title: 'Account Executive', description }),
  }
}

/** In-memory rows that apply the same filter the database does: unresolved, unchecked, 400+ chars. */
function memory(initial: PendingJob[]) {
  const saved = new Map<string, Requirements>()
  const store: RequirementsRows & { saved: typeof saved } = {
    saved,
    async pending(limit) {
      return initial
        .filter((j) => {
          const r = saved.get(j.id) ?? (j.requirements as Requirements)
          return !r.skills_resolved && !r.model_checked_at && j.description.length >= 400
        })
        .slice(0, limit)
        .map((j) => ({ ...j, requirements: saved.get(j.id) ?? j.requirements }))
    },
    async save(id, r) {
      saved.set(id, r)
    },
  }
  return store
}

describe('runRequirementsPass', () => {
  it('sends only postings the parser could not split, and stores what the model read', async () => {
    const rows = memory([job('a', PROSE), job('b', SPLIT)])
    const call = vi.fn().mockResolvedValue('{"must_have":["Salesforce"],"nice_to_have":[],"years_min":3}')
    const res = await runRequirementsPass(rows, call, newModelBudget(10))
    expect(call).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ read: 1, resolved: 1, limited: false })
    expect(rows.saved.get('a')?.must_have).toEqual(['Salesforce'])
    expect(rows.saved.has('b')).toBe(false)
  })

  it('drops items the posting does not say', async () => {
    const rows = memory([job('a', PROSE)])
    const call = vi.fn().mockResolvedValue('{"must_have":["Salesforce","Kubernetes"],"nice_to_have":["Terraform"]}')
    await runRequirementsPass(rows, call, newModelBudget(10))
    expect(rows.saved.get('a')?.must_have).toEqual(['Salesforce'])
    expect(rows.saved.get('a')?.nice_to_have).toEqual([])
  })

  it('marks a posting read after an empty answer, so a second pass does not send it again', async () => {
    const rows = memory([job('a', PROSE)])
    const call = vi.fn().mockResolvedValue('{"must_have":[],"nice_to_have":[],"years_min":null}')
    await runRequirementsPass(rows, call, newModelBudget(10))
    expect(rows.saved.get('a')?.model_checked_at).toBeTruthy()
    await runRequirementsPass(rows, call, newModelBudget(10))
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('does not mark a posting when no model answered, so it is tried again', async () => {
    const rows = memory([job('a', PROSE)])
    const call = vi.fn().mockResolvedValue(null)
    await runRequirementsPass(rows, call, newModelBudget(10))
    expect(rows.saved.size).toBe(0)
    await runRequirementsPass(rows, call, newModelBudget(10))
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('stops when the allowance is spent and says so', async () => {
    const rows = memory([job('a', PROSE), job('b', PROSE + ' b'), job('c', PROSE + ' c')])
    const budget = newModelBudget(0)
    const call = vi.fn().mockResolvedValue(MODEL_LIMIT)
    const res = await runRequirementsPass(rows, call, budget)
    expect(call).not.toHaveBeenCalled()
    expect(res.limited).toBe(true)
  })

  it('reads no more postings than the allowance holds', async () => {
    const rows = memory([job('a', PROSE), job('b', PROSE + ' b'), job('c', PROSE + ' c')])
    const budget = newModelBudget(2)
    const call = vi.fn().mockImplementation(async () => {
      budget.n -= 1
      return '{"must_have":["Salesforce"],"nice_to_have":[]}'
    })
    const res = await runRequirementsPass(rows, call, budget)
    expect(call).toHaveBeenCalledTimes(2)
    expect(res.read).toBe(2)
  })
})
