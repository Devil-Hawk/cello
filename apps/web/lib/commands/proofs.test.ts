// The two proofs and the doors (blueprint 5.1). A person-only command called
// through any other door must throw, an ExtensionProof must be refused by every
// command that is not fill.* or cello.pause, and an actor smuggled into the
// arguments must be refused by the strict input.

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const rpc = vi.fn(async (..._args: unknown[]) => ({ data: null, error: null as { code?: string; message: string } | null }))
let signedIn = true
const supabase = {
  auth: {
    getUser: async () => ({ data: { user: signedIn ? { id: 'user-1', email: 'a@example.com', identities: [] } : null }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
  },
  rpc: (...args: unknown[]) => rpc(...args),
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

import {
  ExtensionProof,
  SessionProof,
  agentDoor,
  assistantDoor,
  chatDoor,
  extensionDoor,
  routineDoor,
  ruleDoor,
  sessionDoor,
  workflowDoor,
} from './doors'
import { runCommand } from './run'
import { defineCommand, type CommandContext } from './define'
import { codeText } from './text'
import { COMMANDS } from './index'
import { isPersonOnly } from './views'

function post(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/x', { method: 'POST', headers })
}

const otherDoors = (): Record<string, CommandContext> => ({
  routine: routineDoor({ userId: 'user-1' }),
  rule: ruleDoor({ userId: 'user-1', ruleId: 'r1' }),
  chat: chatDoor({ userId: 'user-1', typed: 'hello' }),
  assistant: assistantDoor({ userId: 'user-1' }),
  agent: agentDoor({ userId: 'user-1', label: 'tool' }),
  extension: extensionDoor({ userId: 'user-1' }),
  workflowUnderChat: workflowDoor(chatDoor({ userId: 'user-1' })),
})

describe('the proofs cannot be forged', () => {
  it('refuse a constructor call that does not hold the door key', () => {
    expect(() => new SessionProof(Symbol('guess'))).toThrow()
    expect(() => new ExtensionProof(Symbol('guess'))).toThrow()
  })

  it('are minted by exactly the right door', async () => {
    signedIn = true
    const session = await sessionDoor(post())
    expect(session.proof).toBeInstanceOf(SessionProof)
    expect(extensionDoor({ userId: 'user-1' }).proof).toBeInstanceOf(ExtensionProof)
    for (const ctx of [routineDoor({ userId: 'u' }), chatDoor({ userId: 'u' }), assistantDoor({ userId: 'u' })]) {
      expect(ctx.proof).toBeUndefined()
    }
  })
})

describe('every person-only command through every other door', () => {
  const personOnly = COMMANDS.filter((c) => isPersonOnly(c) && !c.id.startsWith('fill.') && c.id !== 'cello.pause')

  it('has person-only commands to test', () => {
    expect(personOnly.length).toBeGreaterThan(0)
  })

  for (const def of personOnly) {
    it(`${def.id} throws at every door but the session`, async () => {
      for (const [name, ctx] of Object.entries(otherDoors())) {
        await expect(runCommand(def, ctx, {}), `${def.id} through ${name}`).rejects.toMatchObject({ status: 403 })
      }
    })

    it(`${def.id} throws for a session context that carries no proof`, async () => {
      const bare: CommandContext = { door: 'session', userId: 'user-1', admin: () => ({}) as never }
      await expect(runCommand(def, bare, {})).rejects.toMatchObject({ status: 403 })
    })
  }
})

describe('an extension proof', () => {
  it('is refused by set_autonomy and conversations.send', async () => {
    rpc.mockClear()
    const ctx = extensionDoor({ userId: 'user-1' })
    for (const id of ['autonomy.update', 'conversations.send']) {
      const def = COMMANDS.find((c) => c.id === id)!
      await expect(runCommand(def, ctx, {})).rejects.toMatchObject({ status: 403 })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('is accepted by a fill command and refused by any other', async () => {
    const ok = defineCommand({
      id: 'fill.probe',
      label: 'Probe',
      input: z.strictObject({}),
      output: z.object({ ok: codeText(10) }),
      callers: ['extension'],
      kind: 'code',
      sends: false,
      egress: 'none',
      measure: 'T13',
      run: async () => ({ ok: 'yes' }),
    })
    const notFill = defineCommand({ ...ok, id: 'probe.other', callers: ['extension'] })
    const ctx = extensionDoor({ userId: 'user-1' })
    await expect(runCommand(ok, ctx, {})).resolves.toEqual({ ok: 'yes' })
    await expect(runCommand(notFill, ctx, {})).rejects.toMatchObject({ status: 403 })
  })
})

describe('the session door', () => {
  it('answers 401 with no signed-in person', async () => {
    signedIn = false
    await expect(sessionDoor(post())).rejects.toMatchObject({ status: 401 })
    signedIn = true
  })

  it('answers 403 for a browser request another site made, and lets a plain read through', async () => {
    signedIn = true
    await expect(sessionDoor(post({ 'sec-fetch-site': 'cross-site' }))).rejects.toMatchObject({ status: 403, code: 'cross_site' })
    await expect(sessionDoor(new Request('http://localhost/api/x', { headers: { 'sec-fetch-site': 'cross-site' } }))).resolves.toBeDefined()
    await expect(sessionDoor(post({ 'sec-fetch-site': 'same-origin' }))).resolves.toBeDefined()
    await expect(sessionDoor(post())).resolves.toBeDefined()
  })

  it('runs autonomy.update through set_autonomy and nothing else', async () => {
    signedIn = true
    rpc.mockClear()
    const ctx = await sessionDoor(post())
    const def = COMMANDS.find((c) => c.id === 'autonomy.update')!
    await expect(runCommand(def, ctx, { pipeline: { sendForMe: true } })).resolves.toEqual({ saved: true })
    expect(rpc).toHaveBeenCalledWith('set_autonomy', { p_pipeline: { sendForMe: true } })
  })

  it('refuses a forged actor in the arguments', async () => {
    signedIn = true
    const ctx = await sessionDoor(post())
    const def = COMMANDS.find((c) => c.id === 'autonomy.update')!
    await expect(runCommand(def, ctx, { pipeline: {}, actor: 'cello' })).rejects.toMatchObject({ status: 400 })
    await expect(runCommand(def, ctx, { pipeline: {}, userId: 'someone-else' })).rejects.toMatchObject({ status: 400 })
  })
})
