// Caps every door: each limit bucket, through each door, against the table in
// blueprint 5.1, with the in-memory slot store standing in for take_command_slot.
// The numbers below are written out here from the blueprint on purpose: a change
// to lib/commands/limits.ts that drifts from the table fails this file.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineCommand, type CommandContext } from './define'
import { agentDoor, assistantDoor, chatDoor, routineDoor } from './doors'
import { runCommand } from './run'
import { memorySlotStore } from './slots'
import { codeText } from './text'
import { limitFor, BUCKET_NAMES } from './limits'

type DoorName = 'chat' | 'assistant' | 'agent' | 'routine'

/** undefined: not limited here. 0: not available at that door. */
const TABLE: Record<string, Partial<Record<DoorName, number>>> = {
  heavy: { chat: 4, assistant: 0, agent: 2 },
  drafts: { chat: 20, assistant: 10, agent: 0 },
  research: { chat: 8, assistant: 0, agent: 4, routine: 0 },
  chance: { chat: 60, assistant: 0, agent: 0 },
  starts: { chat: 10, assistant: 0, agent: 0 },
  people: { chat: 10, assistant: 0, agent: 0 },
  confirm: { chat: 10, assistant: 0, agent: 0 },
}

function doorFor(name: DoorName, slots: ReturnType<typeof memorySlotStore>): CommandContext {
  const base =
    name === 'chat'
      ? chatDoor({ userId: 'u1' })
      : name === 'assistant'
        ? assistantDoor({ userId: 'u1' })
        : name === 'agent'
          ? agentDoor({ userId: 'u1', label: 'tool' })
          : routineDoor({ userId: 'u1' })
  return { ...base, slots }
}

function probe(bucket: string) {
  return defineCommand({
    id: 'probe.run',
    label: 'Probe',
    input: z.strictObject({}),
    output: z.object({ ok: codeText(5) }),
    callers: ['chat', 'assistant', 'agent', 'routine'],
    kind: 'code',
    sends: false,
    egress: 'none',
    limits: { bucket },
    measure: 'T12',
    run: async () => ({ ok: 'yes' }),
  })
}

describe('limits per door', () => {
  it('names every bucket the table does', () => {
    expect([...BUCKET_NAMES].filter((b) => b !== 'search').sort()).toEqual(Object.keys(TABLE).sort())
  })

  for (const [bucket, perDoor] of Object.entries(TABLE)) {
    for (const door of ['chat', 'assistant', 'agent', 'routine'] as DoorName[]) {
      const limit = perDoor[door]
      const label = limit === undefined ? 'is not limited' : limit === 0 ? 'is refused' : `allows ${limit} then refuses`
      it(`${bucket} at the ${door} door ${label}`, async () => {
        const slots = memorySlotStore()
        const ctx = doorFor(door, slots)
        const def = probe(bucket)
        if (limit === undefined) {
          for (let i = 0; i < 70; i++) await expect(runCommand(def, ctx, {})).resolves.toEqual({ ok: 'yes' })
          return
        }
        if (limit === 0) {
          await expect(runCommand(def, ctx, {})).rejects.toMatchObject({ status: 403 })
          return
        }
        for (let i = 0; i < limit; i++) await expect(runCommand(def, ctx, {})).resolves.toEqual({ ok: 'yes' })
        await expect(runCommand(def, ctx, {})).rejects.toMatchObject({ status: 429 })
      })
    }
  }
})

describe('the person door and the search bucket', () => {
  it('gives the person 60 chance roles a day and 12 searches a minute', () => {
    expect(limitFor('chance', 'session')).toEqual({ limit: 60, windowSeconds: 86_400 })
    expect(limitFor('search', 'session')).toEqual({ limit: 12, windowSeconds: 60 })
  })

  it('leaves the routine door unlimited in the heavy bucket', () => {
    expect(limitFor('heavy', 'routine')).toBeNull()
  })

  it('gives a window back when it has passed', async () => {
    let now = 1_000_000_000_000
    const slots = memorySlotStore(() => now)
    const ctx = doorFor('agent', slots)
    const def = probe('heavy')
    await runCommand(def, ctx, {})
    await runCommand(def, ctx, {})
    await expect(runCommand(def, ctx, {})).rejects.toMatchObject({ status: 429 })
    now += 601_000
    await expect(runCommand(def, ctx, {})).resolves.toEqual({ ok: 'yes' })
  })

  it('counts each person apart', async () => {
    const slots = memorySlotStore()
    const a = { ...chatDoor({ userId: 'a' }), slots }
    const b = { ...chatDoor({ userId: 'b' }), slots }
    const def = probe('heavy')
    for (let i = 0; i < 4; i++) await runCommand(def, a, {})
    await expect(runCommand(def, a, {})).rejects.toMatchObject({ status: 429 })
    await expect(runCommand(def, b, {})).resolves.toEqual({ ok: 'yes' })
  })
})
