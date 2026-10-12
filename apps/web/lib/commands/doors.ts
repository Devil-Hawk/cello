// The seven doors (blueprint 5.1). A door builds the CommandContext a command
// runs under, and it is the only place the actor is decided:
//
//   session    the person, through a route with their cookie session
//   routine    the person's scheduled instruction
//   rule       a rule the person stored
//   chat       Cello, in a Chat turn
//   assistant  Cello, over MCP
//   agent      another agent over A2A, with its token label
//   extension  the browser extension, with a fill token
//
// Two doors carry a proof. SessionProof is minted only by sessionDoor and
// ExtensionProof only by extensionDoor: the class constructors refuse any caller
// that does not hold this module's private key. runCommand checks them.
// lib/commands/doors-source.test.ts fails if sessionDoor( is called outside an
// API route or extensionDoor( outside app/api/fill.

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { CommandRefusal, type CommandContext } from './define'

const MINT = Symbol('lib/commands/doors mint key')

/** Proof that the person's own cookie session made this request. */
export class SessionProof {
  readonly kind = 'session' as const
  constructor(key: symbol) {
    if (key !== MINT) throw new Error('SessionProof is minted only by sessionDoor')
  }
}

/** Proof that a fill token made this request. */
export class ExtensionProof {
  readonly kind = 'extension' as const
  constructor(key: symbol) {
    if (key !== MINT) throw new Error('ExtensionProof is minted only by extensionDoor')
  }
}

const admin = () => createAdminClient()

/** The session door. Refuses a request with no signed-in person (401) and a
 *  browser request another site made (403, T27). */
export async function sessionDoor(request: Request): Promise<CommandContext> {
  if (request.method !== 'GET' && request.method !== 'HEAD' && isCrossSiteRequest(request.headers)) {
    throw new CommandRefusal(403, 'This request came from another site.', 'cross_site')
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new CommandRefusal(401, 'Unauthorized', 'unauthorized')
  return {
    door: 'session',
    userId: user.id,
    proof: new SessionProof(MINT),
    supabase: supabase as unknown as CommandContext['supabase'],
    user: { id: user.id, email: user.email || '', identities: user.identities?.map((i) => ({ provider: i.provider })) },
    session: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      return session
    },
    request,
    signal: request.signal,
    admin,
  }
}

export function routineDoor(input: { userId: string; routineId?: string; signal?: AbortSignal }): CommandContext {
  return { door: 'routine', userId: input.userId, ruleId: input.routineId, signal: input.signal, admin }
}

export function ruleDoor(input: { userId: string; ruleId: string; signal?: AbortSignal }): CommandContext {
  return { door: 'rule', userId: input.userId, ruleId: input.ruleId, signal: input.signal, admin }
}

export function chatDoor(input: { userId: string; typed?: string; signal?: AbortSignal }): CommandContext {
  return { door: 'chat', userId: input.userId, typed: input.typed, signal: input.signal, admin }
}

export function assistantDoor(input: { userId: string; signal?: AbortSignal }): CommandContext {
  return { door: 'assistant', userId: input.userId, signal: input.signal, admin }
}

export function agentDoor(input: { userId: string; label: string; signal?: AbortSignal }): CommandContext {
  return { door: 'agent', userId: input.userId, label: input.label, signal: input.signal, admin }
}

/** The extension door. `verified` is what the fill token route has already
 *  checked: the token is valid and belongs to this person. */
export function extensionDoor(verified: { userId: string; signal?: AbortSignal }): CommandContext {
  return { door: 'extension', userId: verified.userId, proof: new ExtensionProof(MINT), signal: verified.signal, admin }
}

/** A fixed workflow running a command under its parent's door. It keeps the
 *  parent's proof, so a workflow started by the person can do what the person
 *  can, and a workflow started by Chat cannot. */
export function workflowDoor(parent: CommandContext): CommandContext {
  return { ...parent, viaWorkflow: true }
}
