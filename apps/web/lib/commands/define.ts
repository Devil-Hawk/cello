// defineCommand: every action on every object, written once (blueprint 5.1).
//
// A command names who may call it, what it takes and returns, whether it sends
// anything out, where it may reach, how it is limited and how it is measured.
// Pages, routines, Chat, workflows, MCP and A2A all run it through runCommand
// (./run.ts), which holds the doors, the proofs, the guards and the counts.
// The actor is never an argument: it is set by the door that built the context.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { AdminClient, Door } from '@/lib/harness/types'
import type { ExtensionProof, SessionProof } from './doors'
import type { SlotStore } from './slots'
import { allowsNoMeasure } from './no-measure'
import { isMeasureId } from './measures'

export type { Door }

/** The seven doors, plus `workflow`: a fixed workflow that runs under its parent's door. */
export type Caller = Door | 'workflow'

/** code: no model. step: one checked model call. wf: a fixed workflow that
 *  contains declared steps. loop: an agent loop. */
export type Kind = 'code' | 'step' | 'wf' | 'loop'

/** Where a command may reach: nowhere, a stored record, text the person typed,
 *  the person's own address, a fixed host, or the person's Gmail. */
export type Egress = 'none' | 'record' | 'typed' | 'person' | 'fixed' | 'gmail'

export interface CommandUser {
  id: string
  email: string
  identities?: { provider: string }[]
}

export interface CommandContext {
  door: Door
  /** True when a workflow is running the command under its parent's door. */
  viaWorkflow?: boolean
  userId: string
  /** The token label, for the agent door. */
  label?: string
  /** The stored rule that started this, for the rule door. */
  ruleId?: string
  /** Minted only by sessionDoor and extensionDoor. */
  proof?: SessionProof | ExtensionProof
  /** The person's own client (RLS applies). Present only at the session door. */
  supabase?: SupabaseClient
  user?: CommandUser
  /** The session's provider token, read on demand. */
  session?: () => Promise<{ provider_token?: string | null } | null>
  request?: Request
  signal?: AbortSignal
  /** What the person typed this turn, for the Chat door. */
  typed?: string
  /** The chat and the person's turn a Chat command runs for: what it makes and starts is recorded against them. */
  chat?: { chatId: string; turnId: string }
  /** A service-role client, built only when a command asks for one. */
  admin: () => AdminClient
  /** Replaces the database counter in tests. */
  slots?: SlotStore
}

export interface CommandDef<I extends z.ZodObject<any> = z.ZodObject<any>, O extends z.ZodType = z.ZodType> {
  /** `object.verb`, lowercase, with underscores. */
  id: string
  label: string
  /** Always strict: an unknown key, such as a forged actor, is refused. */
  input: I
  output: O
  callers: Caller[]
  kind: Kind
  /** True for anything that leaves on the person's behalf. */
  sends: boolean
  egress: Egress
  /** The command needs words the person typed (a quote, a named type). */
  needsTyped?: boolean
  /** The limit bucket (lib/commands/limits.ts) this command draws on. */
  limits?: { bucket: string }
  /** A refusal sentence, or null to go on. */
  guard?(ctx: CommandContext, input: z.output<I>): string | null | Promise<string | null>
  /** The command that reverses this one. */
  undo?: string
  /** A measure id from 13.1, or `none` for the plain record edits no-measure.ts names. */
  measure: string
  /** The command reports progress as it runs. */
  progress?: boolean
  run(ctx: CommandContext, input: z.output<I>): Promise<z.output<O>>
}

export type AnyCommand = CommandDef<any, any>

/** A refusal with the HTTP status a route should answer. The message is a plain
 *  sentence the person can read. */
export class CommandRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'refused'
  ) {
    super(message)
    this.name = 'CommandRefusal'
  }
}

const ID = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/

function isStrict(schema: z.ZodObject<any>): boolean {
  const catchall = (schema as any)._zod?.def?.catchall
  return catchall?._zod?.def?.type === 'never'
}

/** Declares one command. Throws at load time for a definition no test should
 *  have to discover: a bad id, a loose input or an unknown measure. */
export function defineCommand<I extends z.ZodObject<any>, O extends z.ZodType>(def: CommandDef<I, O>): CommandDef<I, O> {
  if (!ID.test(def.id)) throw new Error(`Command id "${def.id}" must look like object.verb`)
  if (!isStrict(def.input)) throw new Error(`Command ${def.id}: the input must be z.strictObject(...)`)
  if (def.callers.length === 0) throw new Error(`Command ${def.id} has no callers`)
  if (def.measure === 'none' ? !allowsNoMeasure(def.id) : !isMeasureId(def.measure)) {
    throw new Error(`Command ${def.id}: measure "${def.measure}" is not a register id or an allowed none`)
  }
  return def
}
