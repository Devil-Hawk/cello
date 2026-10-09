import { describe, expect, it } from 'vitest'
import { advanceOne, answerArrived, categorize, findSlice, resolveFieldValues, syncGmail } from './ports'

describe('the pipeline ports', () => {
  it('each one says it is not built, by name', async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ['advanceOne', () => advanceOne('u1', 'a1')],
      ['answerArrived', () => answerArrived('u1', 'ans1')],
      ['resolveFieldValues', () => resolveFieldValues('u1', 'a1', [])],
      ['categorize', () => categorize('Why do you want to work here?')],
      ['syncGmail', () => syncGmail('u1')],
      ['findSlice', () => findSlice('u1', { employerId: 'e1' })],
    ]
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow(`Not built yet: ${name}`)
  })
})
