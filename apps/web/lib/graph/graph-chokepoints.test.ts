// Guards two invariants the LangGraph port design states about itself
// (docs/superpowers/specs/2026-08-16-langgraph-port-design.md — "Decisions"
// and "Invariants that must survive"):
//
//   1. callLlm stays the ONLY model path; LangChain model abstractions are
//      banned by scan.
//   2. lib/graph/invoke.ts#invokeGraphForUser stays the ONLY place allowed to
//      call graph.invoke/stream.
//
// WHY THIS FILE EXISTS BEFORE ANY GRAPH CODE
//   lib/harness/spend-chokepoints.test.ts and lib/security/injection-
//   chokepoints.test.ts were both written AFTER the bug they guard against
//   had already shipped — each proved itself by catching a real, already-
//   merged violation the day it landed. That proof is unavailable here: there
//   is no graph code yet to have gone wrong. So this file proves itself a
//   different way, by construction — every assertion below is written to
//   PASS on a repo with zero graph files, and to FAIL the moment an
//   offending file appears. scripts/mutation-check-scans.ts is what verifies
//   that claim mechanically (applies the offending mutation, runs the scan,
//   asserts it reports an offender) rather than asking a reviewer to trust it
//   by reading the regex.
//
// WHY THESE TWO BANS
//   LANGCHAIN MODEL ABSTRACTIONS — @langchain/core is a peer dependency of
//   @langchain/langgraph-checkpoint-postgres, pulled in for its TYPES, not
//   its runtime. The moment something imports @langchain/openai (or
//   -anthropic, or -google-genai), or constructs a `new ChatOpenAI(`-shaped
//   client, or calls `.bindTools(`, a SECOND unmetered model path exists —
//   exactly the shape of bug spend-chokepoints.test.ts already had to close
//   once, for a different second path (autoevals/OpenRouter).
//
//   SINGLE CALL SITE — the spec pins invokeGraphForUser as the only file
//   allowed to call graph.invoke/stream: it asserts thread ownership, refuses
//   expired demo threads, and injects {userId, runId, threadId} through
//   config.configurable per request. A second call site is a second place
//   those checks can be forgotten — the structural fix for the historical
//   makeLlmRunner closure bug (userId silently stripped, metering off) only
//   holds if nothing else can call invoke/stream directly.
//
// Both scans are source-level text scans, not type-level ones, for the same
// reason spend-chokepoints.test.ts gives: a source scan catches the NEXT
// offending file, not just the ones a human remembered to review. Both strip
// comments first, so a file cannot satisfy (or trip) either scan by TALKING
// about the pattern rather than containing it.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const WEB_ROOT = process.cwd()
const GRAPH_ROOT = path.resolve(WEB_ROOT, 'lib/graph')

/**
 * Directories a source walk should never descend into.
 *
 * `scripts` is excluded deliberately, not just for speed: scripts/mutation-
 * check-scans.ts is this file's own mutation harness, and its fixture
 * strings legitimately CONTAIN the banned import names and `.invoke(` shape
 * as data, to prove the scan reacts to them — the same reason `isSourceFile`
 * below excludes `.test.` files (this file's own fixtures below have the
 * identical problem). scripts/ is operational tooling, never a runtime
 * model- or graph-call path, so excluding the whole directory is the same
 * shape of choice spend-chokepoints.test.ts already makes by only walking
 * app/api in the first place.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.git',
  '.vercel',
  '.impeccable',
  'coverage',
  'scripts',
])

/** Reused from lib/harness/spend-chokepoints.test.ts's walk shape, widened to a filename predicate. */
function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, keep))
    else if (keep(entry)) out.push(full)
  }
  return out
}

const isSourceFile = (name: string) =>
  (name.endsWith('.ts') || name.endsWith('.tsx')) &&
  !name.includes('.test.') &&
  !name.includes('.eval.')

const rel = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join('/')

/**
 * Source with comment lines removed — same technique lib/access/demo-
 * chokepoints.test.ts uses, for the same reason: a file cannot dodge (or
 * accidentally trip) a scan by putting the trigger text in a comment.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// (a) LangChain model-abstraction ban
// ---------------------------------------------------------------------------
//
// NOTE ON DUPLICATION: scripts/mutation-check-scans.ts keeps its own copy of
// this detection logic in sync BY HAND rather than importing it from here.
// That script must run under plain tsx, outside vitest's runner — importing
// a module that calls `describe`/`it` at top level outside that runner
// throws, so "vitest-independent" and "imported from this file" are mutually
// exclusive. Keep the two copies matching when either changes.

const BANNED_LANGCHAIN_PACKAGES = [
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/google-genai',
]
const BANNED_CHAT_CONSTRUCTOR = /new Chat[A-Z]\w+\(/
const BANNED_BIND_TOOLS = /\.bindTools\(/

function findLangchainBanOffenses(src: string): string[] {
  const stripped = stripComments(src)
  const offenses: string[] = []
  for (const pkg of BANNED_LANGCHAIN_PACKAGES) {
    const importedFrom =
      stripped.includes(`from '${pkg}`) ||
      stripped.includes(`from "${pkg}`) ||
      stripped.includes(`require('${pkg}`) ||
      stripped.includes(`require("${pkg}`)
    if (importedFrom) offenses.push(`imports ${pkg}`)
  }
  if (BANNED_CHAT_CONSTRUCTOR.test(stripped)) offenses.push('constructs a new Chat*( client')
  if (BANNED_BIND_TOOLS.test(stripped)) offenses.push('calls .bindTools(')
  return offenses
}

describe('LangChain model abstractions stay banned', () => {
  it('the ban detects a ChatOpenAI construction (fixture self-test, not a repo file)', () => {
    const fixture = `
      import { ChatOpenAI } from '@langchain/openai'

      const model = new ChatOpenAI({ apiKey: key }).bindTools(tools)
    `
    expect(findLangchainBanOffenses(fixture)).toEqual(
      expect.arrayContaining([
        'imports @langchain/openai',
        'constructs a new Chat*( client',
        'calls .bindTools(',
      ])
    )
  })

  it('a file that merely mentions the ban in a comment is not accused', () => {
    const fixture = `
      // We deliberately do NOT do: new ChatOpenAI({ apiKey }) — see spec.
      import { callLlm } from '@/lib/harness/llm'
    `
    expect(findLangchainBanOffenses(fixture)).toEqual([])
  })

  it('no file under apps/web imports a banned LangChain package, constructs a Chat*( client, or calls .bindTools(', () => {
    const files = walk(WEB_ROOT, isSourceFile)
    // Guards against a broken walk (wrong root, over-eager SKIP_DIRS)
    // silently passing by finding nothing to check.
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      const offenses = findLangchainBanOffenses(readFileSync(file, 'utf8'))
      if (offenses.length > 0) offenders.push(`${rel(file)}: ${offenses.join(', ')}`)
    }
    expect(
      offenders,
      `These files reach a model through a LangChain abstraction instead of ` +
        `callLlm, so they bypass the spend/demo/injection chokepoints entirely:\n  ` +
        offenders.join('\n  ')
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (b) Single call site for graph.invoke/stream
// ---------------------------------------------------------------------------

/** The graph-definition modules a caller might import a compiled graph from. */
const GRAPH_DEFINITION_MODULES = [
  'lib/graph/runs',
  'lib/graph/copilot',
  'lib/graph/refresh',
  'lib/graph/autopilot',
]

/** Path allowlist of exactly one — the single permitted call site. */
const ALLOWED_INVOKE_CALLER = 'lib/graph/invoke.ts'

const IMPORT_SPECIFIER = /from\s+['"]([^'"]+)['"]/g
const INVOKE_OR_STREAM_CALL = /\.invoke\(|\.stream\(/

/**
 * Resolve an import specifier to a WEB_ROOT-relative, extensionless module
 * path — the same resolution TypeScript's `@/*` alias (tsconfig: `@/*` ->
 * `./*`) and relative specifiers both get at build time. Bare package
 * specifiers (no leading '.' or '@/') resolve to null: never a
 * graph-definition module.
 *
 * A prior substring-regex version of this scan (`from ['"][^'"]*(?:lib/graph/
 * runs|...)['"]`) matched the `@/lib/graph/runs` alias every existing caller
 * used, but NOT a relative specifier like `../graph/runs` — the shape
 * lib/a2a/executor.ts and lib/a2a/task-store.ts introduced as the first (and
 * so far only) relative importers of a graph-definition module in the repo.
 * Resolving specifiers properly, instead of pattern-matching their raw text,
 * closes that blind spot for every import style, not just these two files.
 */
function resolveModuleSpecifier(spec: string, filePath: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2)
  if (spec.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(filePath), spec))
  }
  return null
}

/** filePath is repo-relative (posix), e.g. "lib/graph/other.ts". */
function isSecondCallSite(src: string, filePath: string): boolean {
  if (filePath === ALLOWED_INVOKE_CALLER) return false
  const stripped = stripComments(src)
  if (!INVOKE_OR_STREAM_CALL.test(stripped)) return false
  const specifiers = [...stripped.matchAll(IMPORT_SPECIFIER)].map((m) => m[1])
  return specifiers.some((spec) => {
    const resolved = resolveModuleSpecifier(spec, filePath)
    return resolved != null && GRAPH_DEFINITION_MODULES.includes(resolved)
  })
}

describe('graph.invoke/stream has exactly one call site', () => {
  it('detects a second call site (fixture self-test, not a repo file)', () => {
    const fixture = `
      import { compiledRunsGraph } from '@/lib/graph/runs'

      export async function runIt(input: unknown) {
        return compiledRunsGraph.invoke(input)
      }
    `
    expect(isSecondCallSite(fixture, 'lib/harness/rogue-caller.ts')).toBe(true)
  })

  it('detects a second call site reached via a relative import, not just the @/ alias', () => {
    // The exact shape lib/a2a/executor.ts and lib/a2a/task-store.ts use to
    // reach lib/graph/runs.ts — a bare relative specifier, which the old
    // substring-regex version of this scan was blind to (panel-caught: see
    // resolveModuleSpecifier's doc comment above).
    const fixture = `
      import { harnessRunGraph } from '../graph/runs'

      export async function execute() {
        return harnessRunGraph.invoke(null, {} as any)
      }
    `
    expect(isSecondCallSite(fixture, 'lib/a2a/rogue-caller.ts')).toBe(true)
  })

  it('does not accuse the allowed call site of being a second one', () => {
    const fixture = `
      import { compiledRunsGraph } from '@/lib/graph/runs'

      export async function invokeGraphForUser(input: unknown) {
        return compiledRunsGraph.invoke(input)
      }
    `
    expect(isSecondCallSite(fixture, ALLOWED_INVOKE_CALLER)).toBe(false)
  })

  it('does not accuse a file that imports a graph-definition module without invoking it', () => {
    const fixture = `
      import type { CompiledRunsGraph } from '@/lib/graph/runs'

      export function describeGraph(g: CompiledRunsGraph) {
        return g.name
      }
    `
    expect(isSecondCallSite(fixture, 'lib/graph/introspect.ts')).toBe(false)
  })

  it('no file under apps/web other than lib/graph/invoke.ts imports a graph-definition module and calls .invoke(/.stream(', () => {
    const files = walk(WEB_ROOT, isSourceFile)
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      const filePath = rel(file)
      if (isSecondCallSite(readFileSync(file, 'utf8'), filePath)) offenders.push(filePath)
    }
    expect(
      offenders,
      `These files call graph.invoke/stream directly instead of going through ` +
        `lib/graph/invoke.ts#invokeGraphForUser, so thread-ownership, demo-expiry ` +
        `and the {userId, runId, threadId} configurable injection can all be ` +
        `skipped for whatever runs through them:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (c) invoke.ts threads userId through config.configurable
// ---------------------------------------------------------------------------
//
// Presence-based, and deliberately not gated by graph-definition-module
// existence: this is the ONE check in this file that talks about a graph
// file that doesn't exist yet. It runs a real assertion either way (rather
// than it.skip) so a typo in the existsSync guard can't silently vanish the
// whole check — it just turns on automatically once stage 1 adds the file.

// ---------------------------------------------------------------------------
// (d) lib/graph/runs.ts strips untrusted autoSubmit adjacent to planGoal
// ---------------------------------------------------------------------------
//
// Spec invariant 2: every LLM-authored plan passes stripUntrustedSubmit
// before storage or execution. lib/harness/executor.ts enforced this inline,
// right after its own planGoal() call, with a long SAFETY comment explaining
// why (schemas.ts#stripUntrustedSubmit's own header repeats the argument).
// lib/graph/runs.ts#plannerTask is the graph port's equivalent single call
// site — the ONLY place an LLM-authored plan can enter this graph (a
// chain-compiled plan bypasses plannerTask entirely, exactly like it bypassed
// planGoal() in the pre-port executor). This scan is presence-based, not
// gated on lib/graph/runs.ts existing yet, for the same reason part (c)
// above isn't: it runs a real assertion either way, so a typo in the
// existsSync guard can't silently vanish the whole check.
//
// "Adjacent" is checked textually (stripUntrustedSubmit appears within a
// short window after the planGoal( call, comments stripped) rather than via
// brace-counting a function body: plannerTask is a single, short async
// function with exactly one planGoal() call, so a fixed window is simpler
// than parsing and just as precise for that shape — and it still fails
// exactly the way it should if a future edit moves the call far away or
// removes it (see the mutation-check the build report for this file
// documents: deleting the stripUntrustedSubmit call turns this test red).

describe('lib/graph/runs.ts strips untrusted autoSubmit adjacent to its planGoal call', () => {
  const runsFile = path.join(GRAPH_ROOT, 'runs.ts')
  const ADJACENCY_WINDOW = 400

  it('plannerTask calls stripUntrustedSubmit within a short window after planGoal(', () => {
    if (!existsSync(runsFile)) {
      expect(existsSync(runsFile)).toBe(false)
      return
    }

    const stripped = stripComments(readFileSync(runsFile, 'utf8'))
    const planGoalIdx = stripped.indexOf('planGoal(')
    expect(planGoalIdx, 'lib/graph/runs.ts must call planGoal( somewhere (plannerTask)').toBeGreaterThanOrEqual(0)

    const window = stripped.slice(planGoalIdx, planGoalIdx + ADJACENCY_WINDOW)
    expect(
      window,
      'stripUntrustedSubmit must run within a short window after planGoal( — see ' +
        'lib/harness/schemas.ts#stripUntrustedSubmit and spec invariant 2'
    ).toContain('stripUntrustedSubmit(')
  })
})

describe('lib/graph/invoke.ts threads {userId} through config.configurable', () => {
  const invokeFile = path.join(GRAPH_ROOT, 'invoke.ts')

  it('invokeGraphForUser injects configurable/userId — TODO: lib/graph/invoke.ts lands in stage 1 of the port', () => {
    if (!existsSync(invokeFile)) {
      expect(existsSync(invokeFile)).toBe(false)
      return
    }

    const src = readFileSync(invokeFile, 'utf8')
    const fnStart = src.indexOf('function invokeGraphForUser')
    expect(fnStart, 'lib/graph/invoke.ts exists but has no invokeGraphForUser function').toBeGreaterThanOrEqual(0)

    // Isolate the function body textually (brace-counted from the first `{`
    // after the signature) rather than assuming a single-line signature.
    const braceStart = src.indexOf('{', fnStart)
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
    const body = src.slice(fnStart, end + 1)

    expect(body).toContain('configurable')
    expect(body).toContain('userId')
  })
})

// ---------------------------------------------------------------------------
// (e) agent_steps has zero readers or writers left (Step 7 / binding ruling
// 1's endgame: "agent_steps dies; trace_spans wins")
// ---------------------------------------------------------------------------
//
// lib/graph/journal.ts's step ledger and app/api/harness/run/route.ts's
// run-detail read both moved onto trace_spans this stage — the whole point
// being that the DESTRUCTIVE drop-agent_steps migration
// (supabase/migrations/20260817000006_drop_continuations.sql's sibling, or
// the next 20260818xxxxxx file with the same apply-gate header) is safe to
// eventually run once every access is gone from the deployed code, not just
// from the file this stage happened to touch. A source scan catches the
// NEXT file that reaches back into agent_steps, not just the ones a
// reviewer remembered to check.

const AGENT_STEPS_ACCESS = /\.from\(\s*['"]agent_steps['"]\s*\)/

function findAgentStepsAccess(src: string): boolean {
  return AGENT_STEPS_ACCESS.test(stripComments(src))
}

describe('agent_steps has zero readers or writers', () => {
  it('the scan detects a live .from(\'agent_steps\') call (fixture self-test, not a repo file)', () => {
    const fixture = `
      export async function legacyRead(admin: AdminClient, runId: string) {
        return admin.from('agent_steps').select('*').eq('run_id', runId)
      }
    `
    expect(findAgentStepsAccess(fixture)).toBe(true)
  })

  it('a file that merely mentions agent_steps in prose (not a .from( call) is not accused', () => {
    const fixture = `
      // agent_steps is retired (binding ruling 1) — trace_spans is the record now.
      import { journalStepStart } from '@/lib/graph/journal'
    `
    expect(findAgentStepsAccess(fixture)).toBe(false)
  })

  it('no source file under apps/web calls .from(\'agent_steps\')', () => {
    const files = walk(WEB_ROOT, isSourceFile)
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      if (findAgentStepsAccess(readFileSync(file, 'utf8'))) offenders.push(rel(file))
    }
    expect(
      offenders,
      `These files still read or write agent_steps directly instead of going through the trace_spans-backed ` +
        `step ledger (lib/graph/journal.ts) — binding ruling 1 retires the table:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (f) trace_spans has exactly its two known writers (Step 7's journal swap)
// ---------------------------------------------------------------------------
//
// lib/trace/spans.ts wrote trace_spans alone through Step 2; Step 7 made
// lib/graph/journal.ts's upsertStep a second, direct writer (see that file's
// header for why a buffered SpanBuffer flush can't also serve a live,
// resumable step ledger). Both headers now say "two writers" in prose — this
// scan is what makes that an enforced fact instead of a claim a THIRD file
// could quietly falsify, the same shape ruling 4's reply-column single-writer
// scans (lib/access/guardrails.test.ts, lib/outreach/guardrails.test.ts) hold
// for their own tables.

const TRACE_SPANS_FROM = /\.from\(\s*['"]trace_spans['"]\s*\)/g
const WRITE_VERB = /\.(insert|update|upsert|delete)\(/
const WRITE_VERB_WINDOW = 120
const ALLOWED_TRACE_SPANS_WRITERS = new Set(['lib/trace/spans.ts', 'lib/graph/journal.ts'])

function writesTraceSpans(src: string): boolean {
  const stripped = stripComments(src)
  TRACE_SPANS_FROM.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TRACE_SPANS_FROM.exec(stripped))) {
    const window = stripped.slice(match.index, match.index + WRITE_VERB_WINDOW)
    if (WRITE_VERB.test(window)) return true
  }
  return false
}

describe('trace_spans has exactly its two known writers', () => {
  it('the scan detects a mutating .from(\'trace_spans\') call (fixture self-test, not a repo file)', () => {
    const fixture = `
      export async function rogueWrite(admin: AdminClient) {
        return admin.from('trace_spans').insert({ span_id: 'x' })
      }
    `
    expect(writesTraceSpans(fixture)).toBe(true)
  })

  it('a read-only .from(\'trace_spans\').select( is not accused', () => {
    const fixture = `
      export async function readSpans(admin: AdminClient, runId: string) {
        return admin.from('trace_spans').select('span_id').eq('run_id', runId)
      }
    `
    expect(writesTraceSpans(fixture)).toBe(false)
  })

  it('no source file under apps/web other than lib/trace/spans.ts and lib/graph/journal.ts mutates trace_spans', () => {
    const files = walk(WEB_ROOT, isSourceFile)
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      const filePath = rel(file)
      if (ALLOWED_TRACE_SPANS_WRITERS.has(filePath)) continue
      if (writesTraceSpans(readFileSync(file, 'utf8'))) offenders.push(filePath)
    }
    expect(
      offenders,
      `These files write trace_spans directly outside the two known writers ` +
        `(lib/trace/spans.ts's buffered SpanBuffer, lib/graph/journal.ts's ` +
        `synchronous step ledger) — a third writer needs its own review, not a ` +
        `silent addition:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })
})
