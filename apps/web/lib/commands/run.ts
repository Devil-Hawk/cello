// runCommand: the one place a command runs (blueprint 5.1).
//
// In order: the door may call it, the proof matches the door, the input is
// exactly the declared shape, the command's own guard agrees, the door's limit
// has a slot left, then it runs and its output is checked against the declared
// shape. Page buttons, routines, Chat, workflows, MCP and A2A all come through
// here, so none of them can skip a check another one has.

import type { z } from 'zod'
import { CommandRefusal, type AnyCommand, type Caller, type CommandContext, type CommandDef } from './define'
import { ExtensionProof, SessionProof } from './doors'
import { limitFor } from './limits'
import { rpcSlotStore } from './slots'

/** The commands the extension door may call. */
function extensionMayCall(id: string): boolean {
  return id.startsWith('fill.') || id === 'cello.pause'
}

function refuseDoorAndProof(def: AnyCommand, ctx: CommandContext): void {
  const caller: Caller = ctx.viaWorkflow ? 'workflow' : ctx.door
  if (!def.callers.includes(caller)) {
    throw new CommandRefusal(403, 'This action is not available here.', 'door')
  }
  if (ctx.door === 'session' && !(ctx.proof instanceof SessionProof)) {
    throw new CommandRefusal(403, 'This action needs the person signed in.', 'proof')
  }
  if (ctx.door === 'extension') {
    if (!(ctx.proof instanceof ExtensionProof) || !extensionMayCall(def.id)) {
      throw new CommandRefusal(403, 'This action is not available here.', 'proof')
    }
  } else if (ctx.proof instanceof ExtensionProof) {
    throw new CommandRefusal(403, 'This action is not available here.', 'proof')
  }
}

async function takeSlot(def: AnyCommand, ctx: CommandContext): Promise<void> {
  if (!def.limits) return
  const limit = limitFor(def.limits.bucket, ctx.door)
  if (!limit) return
  if (limit.limit <= 0) {
    throw new CommandRefusal(403, 'This action is not available here.', 'limit_zero')
  }
  const store = ctx.slots ?? rpcSlotStore(ctx.admin())
  const ok = await store.take({
    userId: ctx.userId,
    channel: ctx.door,
    bucket: def.limits.bucket,
    limit: limit.limit,
    windowSeconds: limit.windowSeconds,
  })
  if (!ok) throw new CommandRefusal(429, 'That is more than Cello does at once. Try again a little later.', 'limit')
}

export async function runCommand<I extends z.ZodObject<any>, O extends z.ZodType>(
  def: CommandDef<I, O>,
  ctx: CommandContext,
  rawInput: unknown
): Promise<z.output<O>> {
  refuseDoorAndProof(def, ctx)

  const parsed = def.input.safeParse(rawInput ?? {})
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.length ? `${first.path.join('.')}: ` : ''
    throw new CommandRefusal(400, `${where}${first?.message ?? 'Invalid input'}`, 'input')
  }
  const input = parsed.data as z.output<I>

  if (def.guard) {
    const reason = await def.guard(ctx, input)
    if (reason) throw new CommandRefusal(403, reason, 'guard')
  }

  await takeSlot(def, ctx)

  const result = await def.run(ctx, input)
  return def.output.parse(result)
}

/** For routes: the status and body a refusal should answer, or null when the
 *  error is not a refusal and the caller should treat it as a failure. */
export function refusalResponse(e: unknown): { status: number; body: { error: string; code: string } } | null {
  if (e instanceof CommandRefusal) return { status: e.status, body: { error: e.message, code: e.code } }
  return null
}
