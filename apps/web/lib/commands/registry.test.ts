// The registry rules of blueprint 5.1, enforced over every registered command.
// A lane that adds a command in its defs file gets these checks for free: a
// plain z.string() in an output, an actor in an input, a send that a view lists
// or an unknown measure fails here, not in review.

import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { COMMANDS, a2aView, agentView, getCommand, mcpView, workflowView } from './index'
import { MEASURE_IDS } from './measures'
import { allowsNoMeasure } from './no-measure'
import { isPersonOnly } from './views'
import { COPILOT_TOOLS } from '@/lib/harness/copilot-tool-catalog'
import type { AnyCommand } from './define'

// The doors module imports the cookie-backed client; nothing here calls it.
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))


const DOORS = ['session', 'routine', 'rule', 'chat', 'assistant', 'agent', 'extension', 'workflow']
const KINDS = ['code', 'step', 'wf', 'loop']
const EGRESS = ['none', 'record', 'typed', 'person', 'fixed', 'gmail']
const FORBIDDEN_INPUT_KEYS = ['actor', 'door', 'channel', 'user_id', 'userId']

const views = () => [...agentView(), ...mcpView(), ...a2aView(), ...workflowView()]

/** Every node of a JSON schema, depth first. */
function nodes(schema: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(schema)) {
    for (const item of schema) nodes(item, out)
  } else if (schema && typeof schema === 'object') {
    out.push(schema as Record<string, unknown>)
    for (const value of Object.values(schema)) nodes(value, out)
  }
  return out
}

function outputSchema(def: AnyCommand): unknown {
  return z.toJSONSchema(def.output, { unrepresentable: 'any', io: 'output' })
}

/** The strings in an output that no text kind classifies. Enums and constants
 *  are code by nature. */
function unclassifiedStrings(schema: unknown): number {
  return nodes(schema).filter((n) => {
    const isString = n.type === 'string' || (Array.isArray(n.type) && n.type.includes('string'))
    if (!isString) return false
    if (Array.isArray(n.enum) || n.const !== undefined) return false
    return n.text !== 'code' && n.text !== 'untrusted'
  }).length
}

describe('the registry', () => {
  it('holds commands, each with a unique id', () => {
    expect(COMMANDS.length).toBeGreaterThan(0)
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
  })

  it('declares only known callers, kinds and egress values', () => {
    for (const def of COMMANDS) {
      for (const c of def.callers) expect(DOORS, `${def.id} caller ${c}`).toContain(c)
      expect(KINDS, `${def.id} kind`).toContain(def.kind)
      expect(EGRESS, `${def.id} egress`).toContain(def.egress)
    }
  })

  it('never lists a person-only command or a command that sends in any view', () => {
    for (const def of views()) {
      expect(isPersonOnly(def), `${def.id} is person-only`).toBe(false)
      expect(def.sends, `${def.id} sends`).toBe(false)
    }
  })

  it('never lists a command that needs typed words in MCP or A2A', () => {
    for (const def of [...mcpView(), ...a2aView()]) {
      expect(def.needsTyped ?? false, `${def.id} needsTyped`).toBe(false)
      expect(def.egress, `${def.id} egress`).not.toBe('typed')
    }
  })

  it('lets only the session, extension and routine doors call a command that sends', () => {
    for (const def of COMMANDS.filter((c) => c.sends)) {
      for (const c of def.callers) expect(['session', 'extension', 'routine'], `${def.id} caller ${c}`).toContain(c)
    }
  })

  it('has no actor, door, channel or user in any input, and refuses a forged actor', () => {
    for (const def of COMMANDS) {
      for (const key of Object.keys(def.input.shape)) expect(FORBIDDEN_INPUT_KEYS, `${def.id} input key ${key}`).not.toContain(key)
      expect(def.input.safeParse({ actor: 'person', door: 'session' }).success, `${def.id} accepted a forged actor`).toBe(false)
    }
  })

  it('classifies every output string as code text or untrusted text', () => {
    for (const def of COMMANDS) {
      expect(unclassifiedStrings(outputSchema(def)), `${def.id} has an unclassified output string`).toBe(0)
    }
  })

  it('catches a plain z.string() in an output', () => {
    expect(unclassifiedStrings(z.toJSONSchema(z.object({ a: z.string() }), { io: 'output' }))).toBe(1)
  })

  it('allows untrusted JSON only on a command no view lists', () => {
    const listed = new Set(views().map((d) => d.id))
    for (const def of COMMANDS) {
      const json = nodes(outputSchema(def)).some((n) => n.text === 'untrusted' && n.type === undefined)
      if (json) expect(listed.has(def.id), `${def.id} lists untrusted JSON`).toBe(false)
    }
  })

  it('names a measure from the register, or none for a plain record edit', () => {
    for (const def of COMMANDS) {
      if (def.measure === 'none') expect(allowsNoMeasure(def.id), `${def.id} may not say none`).toBe(true)
      else expect(MEASURE_IDS, `${def.id} measure ${def.measure}`).toContain(def.measure)
    }
  })

  it('fails the measure rule for a none outside the list', () => {
    expect(allowsNoMeasure('roles.find')).toBe(false)
    expect(allowsNoMeasure('settings.delete_account')).toBe(true)
    expect(allowsNoMeasure('owner.scorecard')).toBe(true)
  })

  it('keeps model calls out of a code command: no step or model import in a file that declares one', () => {
    const dirs = ['defs', 'send'].map((d) => path.join(__dirname, d))
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const text = readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
        if (!/kind: 'code'/.test(text)) continue
        expect(text, `${file} declares a code command and reaches a model`).not.toMatch(/callLlm|callEmbedding|lib\/steps|defineModelStep/)
      }
    }
  })
})

describe('the person-only commands', () => {
  it('keep conversations.send and autonomy.update to the session door', () => {
    expect(getCommand('conversations.send')?.callers).toEqual(['session'])
    expect(getCommand('autonomy.update')?.callers).toEqual(['session'])
    expect(getCommand('conversations.send')?.sends).toBe(true)
  })
})

describe('the legacy MCP commands (Q6)', () => {
  it('has one assistant-only command per copilot tool, and mcpView lists each by its old name', () => {
    for (const tool of COPILOT_TOOLS) {
      const def = getCommand(`legacy.${tool.name}`)
      expect(def, `legacy.${tool.name}`).toBeDefined()
      expect(def?.callers).toEqual(['assistant'])
      expect(mcpView().map((d) => d.id)).toContain(`legacy.${tool.name}`)
    }
  })

  it('lists no send command to an MCP host', () => {
    expect(mcpView().some((d) => d.id === 'conversations.send')).toBe(false)
  })
})
