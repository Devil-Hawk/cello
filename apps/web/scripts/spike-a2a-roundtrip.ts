// TRANSPORT DECISION PROOF for A2A (langgraph port, Step 3).
//
// Run: npx tsx scripts/spike-a2a-roundtrip.ts
//
// WHAT THIS PROVES, IN-PROCESS, NO NETWORK, NO DATABASE
//   @a2a-js/sdk@1.0.1 exposes TWO server-side JSON-RPC transport handlers
//   sitting in front of the SAME `DefaultRequestHandler` + `AgentExecutor`:
//     - `@a2a-js/sdk/server`'s `JsonRpcTransportHandler` — PascalCase method
//       names ("SendMessage", "GetTask", "CancelTask"), and it decodes the
//       wire JSON with ts-proto's generated `SendMessageRequest.fromJSON`
//       (ts-proto's protobuf-JSON convention: `role` must be the ENUM NAME
//       "ROLE_USER"/"ROLE_AGENT", not the classic-spec string "user"/"agent";
//       a text part's payload lives under `content: {$case:'text',value}`,
//       not the classic `{kind:'text', text}` shape).
//     - `@a2a-js/sdk/compat/v0_3/server`'s `LegacyJsonRpcTransportHandler` —
//       classic slash-method names ("message/send", "tasks/get",
//       "tasks/cancel") over the classic wire JSON (`role:"user"`,
//       `{kind:'text', text}`), hand-translated to the SAME internal
//       proto-shaped request via `toCoreSendMessageRequest` before it ever
//       reaches `DefaultRequestHandler`.
//   A2A clients in the wild (and this repo's own spike facts) speak the
//   CLASSIC wire shape. Fed that shape, the two transports diverge sharply:
//   native ACCEPTS IT WITHOUT ERROR AND SILENTLY DROPS THE CONTENT (role
//   decodes to UNRECOGNIZED, the text part decodes to undefined); compat
//   decodes it correctly end-to-end, and REJECTS a truly malformed classic
//   body loudly (JSON-RPC -32602) instead of guessing.
//
// DECISION: compat/v0_3 (`LegacyJsonRpcTransportHandler`) is the transport
// app/api/a2a/route.ts wires up. Native is not "broken" (case D below proves
// it works perfectly fed ITS OWN wire shape) — it is simply incompatible
// with the classic wire shape every real A2A client sends, and silent
// content loss with a 200-shaped success is the one failure mode a
// content-forwarding endpoint cannot tolerate.

import { JsonRpcTransportHandler, DefaultRequestHandler, InMemoryTaskStore, AgentEvent } from '@a2a-js/sdk/server'
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server'
import type { AgentCard } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'

const AGENT_CARD: AgentCard = {
  name: 'spike-echo-agent',
  description: 'Echoes back the text it receives — proof fixture only.',
  supportedInterfaces: [{ url: 'https://example.invalid/a2a', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' }],
  provider: undefined,
  version: '0.0.0',
  capabilities: { extensions: [], pushNotifications: false, streaming: false },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'echo', name: 'echo', description: 'echoes text', tags: [], examples: [], inputModes: ['text/plain'], outputModes: ['text/plain'], securityRequirements: [] }],
  signatures: [],
}

/** Extracts the first text part's value from a REAL (native-shaped)
 *  Message — `undefined` when nothing usable came through (the corruption
 *  case: role UNRECOGNIZED / a part whose `content` decoded to `undefined`). */
function firstText(msg: { role: number; parts: { content?: { $case: string; value: unknown } }[] }): string | undefined {
  if (msg.role !== 1 /* Role.ROLE_USER */) return undefined
  const part = msg.parts.find((p) => p.content?.$case === 'text')
  return part?.content?.$case === 'text' ? (part.content.value as string) : undefined
}

/** Publishes a `completed` task whose status message echoes whatever text
 *  (if any) it could actually read off the incoming Message — the proof
 *  fixture makes CORRUPTION VISIBLE as an empty echo, not a thrown error. */
class EchoExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const echoed = firstText(ctx.userMessage as unknown as Parameters<typeof firstText>[0]) ?? '<<NOTHING SURVIVED>>'
    bus.publish(
      AgentEvent.task({
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: 3 /* TaskState.TASK_STATE_COMPLETED */,
          message: {
            messageId: 'echo-reply',
            contextId: ctx.contextId,
            taskId: ctx.taskId,
            role: 2 /* Role.ROLE_AGENT */,
            parts: [{ content: { $case: 'text', value: echoed }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        metadata: undefined,
      })
    )
    bus.finished()
  }
  async cancelTask(): Promise<void> {}
}

function freshHandlers() {
  const requestHandler = new DefaultRequestHandler(AGENT_CARD, new InMemoryTaskStore(), new EchoExecutor())
  return {
    native: new JsonRpcTransportHandler(requestHandler),
    compat: new LegacyJsonRpcTransportHandler(requestHandler),
  }
}

const ctx = new ServerCallContext()

const CONTENT = 'score me against the resume, please'

/** A) The classic wire shape every real A2A client sends. */
const classicBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: CONTENT }] },
  },
}

/** B) The SAME payload, but addressed to the native handler's PascalCase
 *  method name — still the classic wire SHAPE inside `params`. */
const classicBodyNativeMethod = { ...classicBody, method: 'SendMessage' }

/** D) A body already in native's own proto-JSON wire shape (ts-proto's
 *  convention: enum NAMES, and a oneof flattened to its field name). */
const nativeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'SendMessage',
  params: {
    message: { kind: 'message', messageId: 'm1', role: 'ROLE_USER', parts: [{ text: CONTENT }] },
  },
}

/** C) A deliberately malformed classic body — a part `kind` outside the
 *  classic spec's closed set (text/file/data), which `toCorePart` cannot
 *  translate into a v1.0 `content` union member. */
const malformedClassicBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'bogus' }] },
  },
}

/** Compat's `result` IS the v0.3 Task object directly (`toCompatTask`);
 *  native's `result` wraps it as `{task: ...}` (see the native switch's
 *  `"messageId" in messageOrTask ? {message:...} : {task:...}"`). Reads
 *  either shape so the same helper serves both call sites below. */
function extractEchoText(rpcResult: unknown): string | undefined {
  const r = rpcResult as {
    result?: { status?: { message?: { parts?: { text?: string }[] } } } | { task?: { status?: { message?: { parts?: { text?: string }[] } } } }
  }
  const result = r.result as { status?: { message?: { parts?: { text?: string }[] } }; task?: { status?: { message?: { parts?: { text?: string }[] } } } } | undefined
  const status = result?.status ?? result?.task?.status
  return status?.message?.parts?.[0]?.text
}

async function main() {
  const transcript: string[] = []
  const log = (line: string) => {
    transcript.push(line)
    console.log(line)
  }

  log('=== A2A transport decision proof ===\n')

  // --- A: compat handler, classic wire shape -> content survives ---------
  {
    const { compat } = freshHandlers()
    const res = (await compat.handle(classicBody, ctx)) as { result?: unknown; error?: unknown }
    const echoed = extractEchoText(res)
    log(`[A] compat + classic JSON  -> echoed="${echoed}"`)
    if (echoed !== CONTENT) throw new Error(`FAIL (A): compat lost content on well-formed classic JSON. Got: ${JSON.stringify(res)}`)
  }

  // --- B: native handler, classic wire shape (PascalCase method) --------
  //     -> SILENT CORRUPTION: no thrown error, but the content is gone.
  {
    const { native } = freshHandlers()
    const res = (await native.handle(classicBodyNativeMethod, ctx)) as { result?: unknown; error?: unknown }
    if (res.error) {
      log(`[B] native + classic JSON  -> THREW (${JSON.stringify(res.error)}) — not the documented corruption; re-verify spike facts.`)
      throw new Error('FAIL (B): expected silent corruption (200-shaped success with lost content), got a thrown error instead.')
    }
    const echoed = extractEchoText(res)
    log(`[B] native + classic JSON  -> NO ERROR, echoed="${echoed}" (expected corruption: NOT "${CONTENT}")`)
    if (echoed === CONTENT) {
      throw new Error('FAIL (B): native handler did NOT corrupt classic-shaped JSON — re-verify the transport decision from scratch.')
    }
  }

  // --- C: compat handler, malformed classic body -> loud failure --------
  {
    const { compat } = freshHandlers()
    const res = (await compat.handle(malformedClassicBody, ctx)) as { result?: unknown; error?: { code: number; message: string } }
    log(`[C] compat + malformed     -> ${res.error ? `LOUD ERROR code=${res.error.code} "${res.error.message}"` : 'NO ERROR (unexpected)'}`)
    if (!res.error) throw new Error(`FAIL (C): compat silently accepted a malformed classic part. Got: ${JSON.stringify(res)}`)
  }

  // --- D: native handler, native's own correct wire shape -> succeeds ---
  //     (ts-proto's JSON encoding flattens the `content` oneof to its
  //     member field name — `{text: "..."}` — rather than `{$case,value}`,
  //     which is the in-memory shape only; that flattening is exactly why
  //     feeding the classic `{kind:'text', text}` shape at [B] above landed
  //     on neither recognized field and decoded to nothing.)
  {
    const { native } = freshHandlers()
    const res = (await native.handle(nativeBody, ctx)) as { result?: { task?: { status?: { message?: { parts?: { text?: string }[] } } } }; error?: unknown }
    const echoed = res.result?.task?.status?.message?.parts?.[0]?.text
    log(`[D] native + native JSON   -> echoed="${echoed}" (native is not broken, just wire-incompatible with classic clients)`)
    if (echoed !== CONTENT) throw new Error(`FAIL (D): native handler failed even on its own correct wire shape. Got: ${JSON.stringify(res)}`)
  }

  log('\n=== DECISION: compat/v0_3 (LegacyJsonRpcTransportHandler) — classic method names, content survives, malformed input fails loud. ===')
  log('app/api/a2a/route.ts wires LegacyJsonRpcTransportHandler against a DefaultRequestHandler; see that file\'s header comment for the same transcript.')
}

main().catch((err) => {
  console.error('\nSPIKE PROOF FAILED:', err)
  process.exit(1)
})
