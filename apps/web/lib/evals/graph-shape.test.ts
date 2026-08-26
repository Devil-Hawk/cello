// Graph-shape regression tests — invariant 6 (docs/superpowers/specs/
// 2026-08-16-langgraph-port-design.md, "Invariants that must survive"):
// "autoSubmit:false and submitOrSendReason are not reachable or bypassable
// via any graph edge (graph-shape regression tests)."
//
// Each describe block below is a PURE source-text scan of one graph file —
// no mocks, no compiled graph, no vitest module mocking — proving a
// structural claim about that file's own shape rather than observing one
// run's behaviour. That's what makes them a natural, dependency-free set to
// keep together in one place, separate from the runtime tests (which DO need
// each graph's own mock harness — vi.mock'd callLlm, a MemorySaver, a
// compiled graph — and stay in their own graph's test file, right next to
// the fixtures/helpers they share with the rest of that file's coverage):
//
//   - copilot.ts: dispatchExecute calls submitOrSendReason unconditionally,
//     strictly before dispatchTool — no graph edge (bypassMode, thinkingMode)
//     can route around the confirm/review guard. lib/graph/copilot.test.ts's
//     own "(b) runtime" block proves the SAME invariant by actually driving
//     the compiled graph with bypassMode:true; this file proves it holds by
//     construction, in the source, and stays there rather than duplicating.
//   - autopilot.ts: only draftTask's own applier call can reach a submit
//     path — sourceTask/scoreTask/judgeTask never mention applier,
//     submissionRef or buildSubmitConfirmedPlan — and the entrypoint itself
//     never calls interrupt() (autopilot's budget stop is a terminal return,
//     never a paused/resumable interrupt a later tick could reopen).
//
// PURE MOVE from lib/graph/copilot.test.ts and lib/graph/autopilot.test.ts —
// zero logic changes. Consolidated here (Step 8 of the langgraph port) so a
// reader auditing invariant 6 reads one file instead of two; each source's
// OWN runtime tests (the mock-driven proofs of the same invariant) were left
// where they already lived sensibly, next to that file's other coverage.
//
// app/api/mcp/route.ts joins this file for the SAME invariant (MCP step of
// the port): submitOrSendReason must run unconditionally, strictly before
// dispatchTool, inside the one tool-callback template buildServer() registers
// for all 19 tools — MCP has no confirm/review interrupt to fall back on (no
// human is watching this connection), so a guard that could be skipped here
// would be a silent auto-approval, not a pause. See that file's own header.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// copilot.ts — dispatchExecute source order
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

/** Extracts `async function dispatchExecute(...) { ... }`'s body by brace
 *  counting — same technique graph-chokepoints.test.ts uses for
 *  invokeGraphForUser. Works against ANY source string (the real file, or a
 *  mutated copy), which is what makes the mutation check below possible. */
function extractDispatchExecuteBody(src: string): string {
  const stripped = stripComments(src)
  const start = stripped.indexOf('async function dispatchExecute')
  if (start < 0) throw new Error('dispatchExecute not found in source')
  const braceStart = stripped.indexOf('{', start)
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++
    if (stripped[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  return stripped.slice(start, end + 1)
}

/** The assertion under test: submitOrSendReason runs unconditionally (no
 *  `if` gate mentioning bypassMode/thinkingMode precedes it), strictly
 *  before dispatchTool. Returns a list of violations (empty = passes) so the
 *  same function drives both the real-file assertion and the mutation
 *  check below. */
function findDispatchExecuteGuardViolations(body: string): string[] {
  const violations: string[] = []
  const guardIdx = body.indexOf('submitOrSendReason(')
  const execIdx = body.indexOf('dispatchTool(')
  if (guardIdx < 0) violations.push('submitOrSendReason( not found in dispatchExecute')
  if (execIdx < 0) violations.push('dispatchTool( not found in dispatchExecute')
  if (guardIdx >= 0 && execIdx >= 0 && guardIdx > execIdx) {
    violations.push('submitOrSendReason( appears AFTER dispatchTool( — the guard would run too late to stop the call')
  }
  if (guardIdx > 0) {
    const before = body.slice(0, guardIdx)
    if (/if\s*\([^)]*(bypassMode|thinkingMode)/.test(before)) {
      violations.push('submitOrSendReason( is reached only through a bypassMode/thinkingMode conditional — it must be unconditional')
    }
  }
  return violations
}

const COPILOT_SOURCE_PATH = path.join(process.cwd(), 'lib/graph/copilot.ts')

describe('dispatchExecute source order: submitOrSendReason before dispatchTool, unconditionally', () => {
  it('the real file has no violations', () => {
    const body = extractDispatchExecuteBody(readFileSync(COPILOT_SOURCE_PATH, 'utf8'))
    expect(findDispatchExecuteGuardViolations(body)).toEqual([])
  })

  it('MUTATION CHECK: reordering the guard after dispatchTool in a copy goes red', () => {
    const real = readFileSync(COPILOT_SOURCE_PATH, 'utf8')
    const body = extractDispatchExecuteBody(real)
    // Sanity: the guard call really is present before mutating.
    expect(body.indexOf('submitOrSendReason(')).toBeLessThan(body.indexOf('dispatchTool('))

    // Simulate "the guard moved after the real call" by swapping which
    // substring comes first, entirely in memory — never touches the file on
    // disk.
    const mutated = body.replace(
      /const submitReason = submitOrSendReason\(tool, args\)/,
      '/* MUTATED: guard moved past the call */'
    ) + '\n// submitOrSendReason(tool, args) // moved here, after dispatchTool( already ran above'
    const violations = findDispatchExecuteGuardViolations(mutated)
    expect(violations.length).toBeGreaterThan(0)
  })

  it('MUTATION CHECK: gating the guard behind an `if (bypassMode)` in a copy goes red', () => {
    const real = readFileSync(COPILOT_SOURCE_PATH, 'utf8')
    const body = extractDispatchExecuteBody(real)
    const mutated = body.replace(
      'const submitReason = submitOrSendReason(tool, args)',
      'let submitReason = null\n  if (!state.turnConfig.bypassMode) { submitReason = submitOrSendReason(tool, args) }'
    )
    expect(findDispatchExecuteGuardViolations(mutated)).toEqual([
      'submitOrSendReason( is reached only through a bypassMode/thinkingMode conditional — it must be unconditional',
    ])
  })
})

// ---------------------------------------------------------------------------
// autopilot.ts — only draftTask's own helper can reach applier or a submit path
// ---------------------------------------------------------------------------

describe('autopilotTickGraph — graph shape', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'lib/graph/autopilot.ts'), 'utf8')

  it('sourceTask, scoreTask and judgeTask never mention applier, submissionRef or a submit path', () => {
    for (const [name, marker] of [
      ['sourceTask', "task('source'"],
      ['scoreTask', "task('score'"],
      ['judgeTask', "task('judge'"],
    ] as const) {
      const start = src.indexOf(marker)
      expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
      // Brace-counted from the task's arrow-function body (same idiom as
      // graph-chokepoints.test.ts's invokeGraphForUser extraction), not a
      // fixed-length window: judgeTask's own body runs well past 1500 chars,
      // so that window used to end mid-body — silently passing regardless of
      // what the REST of judgeTask contained — while a short task like
      // sourceTask's window ran hundreds of chars past its closing `})` and
      // into the next task's unrelated code.
      const braceStart = src.indexOf('{', start)
      let depth = 0
      let end = braceStart
      for (let i = braceStart; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1
        if (src[i] === '}') {
          depth -= 1
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const body = src.slice(start, end + 1)
      expect(body).not.toMatch(/applier|submissionRef|buildSubmitConfirmedPlan/)
    }
  })

  it('the entrypoint itself never calls interrupt() — a soft budget stop is a terminal return', () => {
    // Prose in the header talks ABOUT interrupt() (contrasting autopilot with
    // runs.ts/refresh.ts); what must never appear is an actual import of it
    // or a call site, so this scans code lines only (same technique as
    // graph-chokepoints.test.ts's stripComments).
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(codeOnly).not.toMatch(/\binterrupt\(/)
    expect(codeOnly).not.toMatch(/\{[^}]*\binterrupt\b[^}]*\}\s*from\s*['"]@langchain\/langgraph['"]/)
  })
})

// ---------------------------------------------------------------------------
// app/api/mcp/route.ts — the tool-callback template's guard order
// ---------------------------------------------------------------------------

const MCP_ROUTE_SOURCE_PATH = path.join(process.cwd(), 'app/api/mcp/route.ts')

/** Extracts the one `async (args): Promise<CallToolResult> => { ... }`
 *  callback buildServer() registers for every tool — same brace-counting
 *  technique as extractDispatchExecuteBody above, applied to an arrow
 *  function instead of a `function` declaration. Works against any source
 *  string, real or mutated, which is what makes the mutation check below
 *  possible. */
function extractMcpToolCallbackBody(src: string): string {
  const stripped = stripComments(src)
  const marker = 'async (args): Promise<CallToolResult> => {'
  const start = stripped.indexOf(marker)
  if (start < 0) throw new Error('MCP tool callback not found in source')
  const braceStart = start + marker.length - 1
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++
    if (stripped[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  return stripped.slice(start, end + 1)
}

/** Same shape as findDispatchExecuteGuardViolations above: the guard runs
 *  before the dispatch, and nothing conditional stands in front of it. MCP
 *  has no bypassMode/thinkingMode to gate on — the only unconditional-ness
 *  question here is whether ANY `if` precedes the guard call at all. */
function findMcpGuardViolations(body: string): string[] {
  const violations: string[] = []
  const guardIdx = body.indexOf('submitOrSendReason(')
  const execIdx = body.indexOf('dispatchTool(')
  if (guardIdx < 0) violations.push('submitOrSendReason( not found in the MCP tool callback')
  if (execIdx < 0) violations.push('dispatchTool( not found in the MCP tool callback')
  if (guardIdx >= 0 && execIdx >= 0 && guardIdx > execIdx) {
    violations.push('submitOrSendReason( appears AFTER dispatchTool( — the guard would run too late to stop the call')
  }
  if (guardIdx > 0 && /\bif\s*\(/.test(body.slice(0, guardIdx))) {
    violations.push('submitOrSendReason( is reached only through a conditional — MCP has no human-confirm channel, so it must be unconditional')
  }
  return violations
}

describe('app/api/mcp/route.ts tool callback: submitOrSendReason before dispatchTool, unconditionally', () => {
  it('the real file has no violations', () => {
    const body = extractMcpToolCallbackBody(readFileSync(MCP_ROUTE_SOURCE_PATH, 'utf8'))
    expect(findMcpGuardViolations(body)).toEqual([])
  })

  it('MUTATION CHECK: removing the guard precheck in a copy goes red', () => {
    const real = readFileSync(MCP_ROUTE_SOURCE_PATH, 'utf8')
    const body = extractMcpToolCallbackBody(real)
    expect(body.indexOf('submitOrSendReason(')).toBeLessThan(body.indexOf('dispatchTool('))

    const mutated = body.replace(
      /const reason = submitOrSendReason\(spec\.name, toolArgs\)\s*\n\s*if \(reason\) return refusalResult\(reason\)\n/,
      '// MUTATED: guard precheck removed\n'
    )
    const violations = findMcpGuardViolations(mutated)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations).toContain('submitOrSendReason( not found in the MCP tool callback')
  })

  it('MUTATION CHECK: gating the guard behind an `if` in a copy goes red', () => {
    const real = readFileSync(MCP_ROUTE_SOURCE_PATH, 'utf8')
    const body = extractMcpToolCallbackBody(real)
    const mutated = body.replace(
      'const reason = submitOrSendReason(spec.name, toolArgs)',
      "let reason = null\n          if (spec.kind !== 'run') { reason = submitOrSendReason(spec.name, toolArgs) }"
    )
    expect(findMcpGuardViolations(mutated)).toEqual([
      'submitOrSendReason( is reached only through a conditional — MCP has no human-confirm channel, so it must be unconditional',
    ])
  })
})
