/**
 * Mutation-checks the source-level chokepoint scans that walk arbitrary text
 * (a real repo tree, or a fixed file's full source) rather than exercising a
 * unit through its real runtime behavior.
 *
 * WHY THIS SCRIPT EXISTS
 *   lib/graph/graph-chokepoints.test.ts asserts, of a repo with zero graph
 *   files, that two bans hold: no LangChain model abstraction, and no second
 *   graph.invoke/stream call site. Both assertions currently pass trivially
 *   — there is nothing to trip them on. A scan that passes because it finds
 *   nothing is indistinguishable, by its green checkmark alone, from a scan
 *   whose regex is simply wrong and would stay green forever. The spec (see
 *   "Invariants that must survive": "every marker change ships with an
 *   executed mutation test") asks for the mutation checklist to be run, not
 *   just written down as a reviewer's TODO.
 *
 *   This script is that execution. For each entry in MUTATION_CASES it takes
 *   a clean, in-memory fixture string that the real scan logic accepts,
 *   applies a mutation that introduces exactly the offense the scan exists
 *   to catch, and asserts the SAME scan logic now reports an offender. It
 *   also asserts the clean baseline reports none, so a scan that fires on
 *   everything can't pass by accident either. Nothing here touches disk or
 *   the real repo tree — see graph-chokepoints.test.ts's own fixture
 *   self-tests for that half; this script exists to prove those fixtures
 *   are not accidentally vacuous.
 *
 * WHICH CHOKEPOINTS ARE (AND AREN'T) HERE
 *   Every stage of the langgraph port accumulated a "prove the guard can't
 *   silently rot" checklist: langchain ban, single-call-site,
 *   stripUntrustedSubmit adjacency, unmetered-wrapper (below), plus
 *   submitOrSendReason source order, containment detection and the demo
 *   autoSubmit-flip guard. The last three are deliberately NOT duplicated
 *   here: each is already proven by a test that calls the REAL function
 *   (lib/graph/copilot.test.ts's dispatchExecute mutation checks, lib/graph/
 *   unit.test.ts's containment describe block, lib/access/guardrails.test.ts
 *   /lib/graph/autopilot.test.ts's autoSubmit:false assertions) rather than
 *   a text-pattern proxy for it — a direct behavioral assertion against
 *   mutated real behavior has no "the regex could be wrong" failure mode to
 *   guard against, so wrapping it in this fixture harness would just
 *   duplicate logic without proving anything new. This script is only for
 *   scans that FIND their target by pattern-matching text, since that's the
 *   one failure mode a real-behavior test can't catch on its own.
 *
 * WHY THE SCAN LOGIC IS DUPLICATED, NOT IMPORTED
 *   This script must run under plain tsx (`pnpm mutation:scans`), outside
 *   vitest's runner. The chokepoint test files call `describe`/`it` from the
 *   `vitest` package at module scope; importing one of those modules outside
 *   vitest's own runner throws before this script could use the pieces it
 *   wants. So the detection functions below are hand-kept copies of
 *   graph-chokepoints.test.ts's findLangchainBanOffenses, isSecondCallSite
 *   and the stripUntrustedSubmit adjacency window, plus spend-chokepoints
 *   .test.ts's CALL_LLM_WRAPPERS arg-count heuristic. KEEP THEM IN SYNC — if
 *   you change one file's version, change the other's, and re-run
 *   `pnpm mutation:scans` to prove both still agree with reality.
 *
 * Exit code is 0 iff every case's scan behaves as the case declares it
 * should on BOTH the baseline and the mutated string; nonzero and a printed
 * failure otherwise, so this is safe to wire into a gate.
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

// --- kept in sync with lib/graph/graph-chokepoints.test.ts: (a) ------------

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

// --- kept in sync with lib/graph/graph-chokepoints.test.ts: (b) ------------

const GRAPH_DEFINITION_MODULES = [
  'lib/graph/runs',
  'lib/graph/copilot',
  'lib/graph/refresh',
  'lib/graph/autopilot',
]
const ALLOWED_INVOKE_CALLER = 'lib/graph/invoke.ts'
const IMPORT_SPECIFIER = /from\s+['"]([^'"]+)['"]/g
const INVOKE_OR_STREAM_CALL = /\.invoke\(|\.stream\(/

// Resolves an import specifier to a WEB_ROOT-relative, extensionless module
// path (both the '@/*' alias and relative specifiers), rather than pattern-
// matching the specifier's raw text — a prior substring-regex version of
// this scan matched the '@/lib/graph/runs' alias every existing caller
// used, but not a relative specifier like '../graph/runs'. See
// lib/graph/graph-chokepoints.test.ts's resolveModuleSpecifier for the full
// story; this is the hand-kept copy (KEEP THEM IN SYNC — see file header).
function resolveModuleSpecifier(spec: string, filePath: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2)
  if (spec.startsWith('.')) {
    const dir = filePath.split('/').slice(0, -1)
    for (const part of spec.split('/')) {
      if (part === '.' || part === '') continue
      if (part === '..') dir.pop()
      else dir.push(part)
    }
    return dir.join('/')
  }
  return null
}

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

// --- kept in sync with lib/graph/graph-chokepoints.test.ts: (d) ------------

const ADJACENCY_WINDOW = 400

function stripUntrustedSubmitAdjacencyViolations(src: string): string[] {
  const violations: string[] = []
  const stripped = stripComments(src)
  const planGoalIdx = stripped.indexOf('planGoal(')
  if (planGoalIdx < 0) {
    violations.push('planGoal( not found')
    return violations
  }
  const window = stripped.slice(planGoalIdx, planGoalIdx + ADJACENCY_WINDOW)
  if (!window.includes('stripUntrustedSubmit(')) {
    violations.push('stripUntrustedSubmit( not found within window after planGoal(')
  }
  return violations
}

// --- kept in sync with lib/harness/spend-chokepoints.test.ts: CALL_LLM_WRAPPERS check ---
//
// CALL_LLM_WRAPPERS itself is empty (the makeLlmRunner wrapper it once
// covered was deleted by the langgraph port — see that file's own header),
// so the real `it.each(CALL_LLM_WRAPPERS)` currently runs zero cases. This
// case proves the ARG-COUNT HEURISTIC itself still reacts, independent of
// whether any route currently uses it — the same shape of proof the two
// cases above give the walk-based scans.

function isUnmeteredWrapperCall(src: string, marker: string): boolean {
  if (!src.includes(marker)) return false
  const calls = src.split(marker).slice(1)
  return calls.some((tail) => {
    const args = tail.slice(0, tail.indexOf(')'))
    return !args.includes(',')
  })
}

// ---------------------------------------------------------------------------

interface MutationCase {
  /** What this case is proving, for the printed report. */
  name: string
  /** Which real test this stands in for — printed on failure so a human knows where to look. */
  expectedFailingTest: string
  /** Clean fixture text the scan must accept (report zero offenders / not-an-offender). */
  baseline: string
  /** Turns the baseline into exactly the offense the scan exists to catch. */
  mutate: (baseline: string) => string
  /** Runs the real (duplicated) scan logic; true means "an offender was reported". */
  scanReportsOffender: (mutatedSrc: string) => boolean
}

const MUTATION_CASES: MutationCase[] = [
  {
    name: 'LangChain ban: new ChatOpenAI( construction',
    expectedFailingTest:
      "lib/graph/graph-chokepoints.test.ts > 'LangChain model abstractions stay banned' > " +
      "'no file under apps/web imports a banned LangChain package, constructs a Chat*( client, or calls .bindTools('",
    baseline: `
      import { callLlm } from '@/lib/harness/llm'

      export async function draft(prompt: string) {
        return callLlm({ userId: 'u1' }, { prompt })
      }
    `,
    mutate: (src) =>
      src.replace(
        "import { callLlm } from '@/lib/harness/llm'",
        "import { callLlm } from '@/lib/harness/llm'\n" +
          "      import { ChatOpenAI } from '@langchain/openai'\n" +
          '      const model = new ChatOpenAI({ apiKey: key })'
      ),
    scanReportsOffender: (src) => findLangchainBanOffenses(src).length > 0,
  },
  {
    name: 'Single call site: a second file invokes a graph-definition export',
    expectedFailingTest:
      "lib/graph/graph-chokepoints.test.ts > 'graph.invoke/stream has exactly one call site' > " +
      "'no file under apps/web other than lib/graph/invoke.ts imports a graph-definition module and calls .invoke(/.stream('",
    baseline: `
      export async function runIt(input: unknown) {
        return input
      }
    `,
    mutate: (src) =>
      `import { compiledRunsGraph } from '@/lib/graph/runs'\n` + src.replace('return input', 'return compiledRunsGraph.invoke(input)'),
    // A rogue caller — anything other than the one allowed path.
    scanReportsOffender: (src) => isSecondCallSite(src, 'lib/harness/rogue-caller.ts'),
  },
  {
    name: 'stripUntrustedSubmit adjacency: the guard moves out of the window after planGoal(',
    expectedFailingTest:
      "lib/graph/graph-chokepoints.test.ts > 'lib/graph/runs.ts strips untrusted autoSubmit adjacent to its planGoal call' > " +
      "'plannerTask calls stripUntrustedSubmit within a short window after planGoal('",
    baseline: `
      async function plannerTask(input: PlannerInput) {
        const plan = await planGoal(input, ctx)
        const safePlan = stripUntrustedSubmit(plan)
        return safePlan
      }
    `,
    mutate: (src) => src.replace('const safePlan = stripUntrustedSubmit(plan)', 'const safePlan = plan // guard removed'),
    scanReportsOffender: (src) => stripUntrustedSubmitAdjacencyViolations(src).length > 0,
  },
  {
    name: 'Unmetered wrapper: a callLlm wrapper loses its userId argument',
    expectedFailingTest:
      "lib/harness/spend-chokepoints.test.ts > 'every path to a model is behind the spend cap' > " +
      "'every route calling %s passes a user id, so callLlm actually meters' (CALL_LLM_WRAPPERS)",
    baseline: `
      export async function draft(config: Config, userId: string) {
        return makeLlmRunner(config.key, userId)
      }
    `,
    mutate: (src) => src.replace('makeLlmRunner(config.key, userId)', 'makeLlmRunner(config.key)'),
    scanReportsOffender: (src) => isUnmeteredWrapperCall(src, 'makeLlmRunner('),
  },
]

function run(): boolean {
  let allPassed = true

  for (const testCase of MUTATION_CASES) {
    const baselineOffends = testCase.scanReportsOffender(testCase.baseline)
    const mutated = testCase.mutate(testCase.baseline)
    const mutatedOffends = testCase.scanReportsOffender(mutated)

    const baselineOk = baselineOffends === false
    const mutatedOk = mutatedOffends === true
    const passed = baselineOk && mutatedOk

    if (passed) {
      console.log(`PASS  ${testCase.name}`)
    } else {
      allPassed = false
      console.error(`FAIL  ${testCase.name}`)
      console.error(`      guards: ${testCase.expectedFailingTest}`)
      if (!baselineOk) {
        console.error('      baseline (clean) fixture was flagged as an offender — scan is over-eager.')
      }
      if (!mutatedOk) {
        console.error('      mutated (offending) fixture was NOT flagged — scan would silently pass a real violation.')
      }
    }
  }

  return allPassed
}

const ok = run()
if (!ok) {
  console.error('\nmutation:scans FAILED — at least one chokepoint scan did not react to its mutation.')
  process.exit(1)
}
console.log(`\nmutation:scans OK — ${MUTATION_CASES.length} scan(s) proven non-vacuous.`)
