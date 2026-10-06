// Bounded fan-out: the same job over many items, a few at a time.
//
// Used inside a tool (research six companies, source across boards), never to
// split one document across agents. It is a small LangGraph graph:
//
//   START -> dispatch (one Send per item) -> branch -> synthesize
//
// run with maxConcurrency 4, so at most four branches are alive at once. Code
// bounds every branch, not a prompt:
//
//   - a time cap per branch (AbortSignal.timeout) and the request deadline: past
//     the deadline no new branch starts and it reports partial, reason time
//   - a step and token cap per branch, handed to the worker to enforce
//   - a worker that hits the budget (BudgetCapError) reports partial, reason budget
//
// Every branch reports ok, partial (with the reason) or failed, and one failure
// never sinks the rest. A graph interrupt is not a failure and is passed up.

import { Annotation, END, isGraphBubbleUp, Send, START, StateGraph } from '@langchain/langgraph'
import { isBudgetCapError } from './spend-port'

export const MAX_CONCURRENCY = 4

export interface BranchCaps {
  steps: number
  ms: number
  tokens: number
}

export type PartialReason = 'budget' | 'time' | 'steps'

export interface BranchResult<R> {
  index: number
  status: 'ok' | 'partial' | 'failed'
  reason?: PartialReason
  value?: R
  error?: string
}

/** Returned by a worker that stopped early on purpose but has something to show. */
export class PartialValue<R> {
  constructor(
    readonly reason: PartialReason,
    readonly value: R
  ) {}
}

export interface BranchContext {
  index: number
  /** Aborts at the branch time cap or when the request is cancelled. */
  signal: AbortSignal
  deadlineAt: number
  caps: BranchCaps
}

export interface FanOutOptions<I, R> {
  items: readonly I[]
  worker: (item: I, branch: BranchContext) => Promise<R | PartialValue<R>>
  caps: BranchCaps
  /** Epoch ms. No new branch starts after it. */
  deadlineAt: number
  /** The request's own abort signal. */
  signal?: AbortSignal
  /** Called as each branch starts and ends (the task tree writer). Errors here never fail a branch. */
  onBranch?: (event: BranchEvent<I, R>) => void | Promise<void>
  /** Test seam: the most branches alive at once. Never above 4. */
  maxConcurrency?: number
}

export type BranchEvent<I, R> =
  | { phase: 'start'; index: number; item: I }
  | { phase: 'end'; index: number; item: I; result: BranchResult<R> }

export interface FanOutResult<R> {
  /** In item order. */
  results: BranchResult<R>[]
  counts: { ok: number; partial: number; failed: number }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const isTimeout = (e: unknown): boolean => {
  const name = (e as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export async function fanOut<I, R>(opts: FanOutOptions<I, R>): Promise<FanOutResult<R>> {
  const limit = Math.min(Math.max(opts.maxConcurrency ?? MAX_CONCURRENCY, 1), MAX_CONCURRENCY)

  const State = Annotation.Root({
    results: Annotation<BranchResult<R>[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
    counts: Annotation<FanOutResult<R>['counts']>({ reducer: (_a, b) => b, default: () => ({ ok: 0, partial: 0, failed: 0 }) }),
  })

  async function runBranch(index: number): Promise<BranchResult<R>> {
    const item = opts.items[index]
    try {
      await opts.onBranch?.({ phase: 'start', index, item })
    } catch {
      // The task tree is a view; it never fails the work.
    }
    const result = await execute(index, item)
    try {
      await opts.onBranch?.({ phase: 'end', index, item, result })
    } catch {
      // as above
    }
    return result
  }

  async function execute(index: number, item: I): Promise<BranchResult<R>> {
    if (opts.signal?.aborted) return { index, status: 'partial', reason: 'time' }
    // The request is close to its slice limit: do not start new work.
    if (Date.now() >= opts.deadlineAt) return { index, status: 'partial', reason: 'time' }
    const timeout = AbortSignal.timeout(opts.caps.ms)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    try {
      const out = await opts.worker(item, { index, signal, deadlineAt: opts.deadlineAt, caps: opts.caps })
      if (out instanceof PartialValue) return { index, status: 'partial', reason: out.reason, value: out.value }
      return { index, status: 'ok', value: out }
    } catch (e) {
      if (isGraphBubbleUp(e)) throw e
      if (isBudgetCapError(e)) return { index, status: 'partial', reason: 'budget', error: errorText(e) }
      if (timeout.aborted || isTimeout(e)) return { index, status: 'partial', reason: 'time' }
      return { index, status: 'failed', error: errorText(e) }
    }
  }

  // A Send's payload is the node's input as given, so the branch node takes {index}, not the whole state.
  const branchNode = async (input: { index: number }) => ({ results: [await runBranch(input.index)] })

  const graph = new StateGraph(State)
    .addNode('dispatch', () => ({}))
    .addNode('branch', branchNode as never)
    .addNode('synthesize', (state) => {
      const counts = { ok: 0, partial: 0, failed: 0 }
      for (const r of state.results) counts[r.status] += 1
      return { counts }
    })
    .addEdge(START, 'dispatch')
    .addConditionalEdges('dispatch', () => opts.items.map((_, index) => new Send('branch', { index })), ['branch'])
    .addEdge('branch', 'synthesize')
    .addEdge('synthesize', END)
    .compile()

  if (opts.items.length === 0) return { results: [], counts: { ok: 0, partial: 0, failed: 0 } }

  const out = await graph.invoke({ results: [] }, { maxConcurrency: limit, recursionLimit: 25 })
  return { results: [...out.results].sort((a, b) => a.index - b.index), counts: out.counts }
}

/** "Researching 6 companies (4 done, 1 partial, 1 failed)" */
export function summarizeCounts(verb: string, noun: { one: string; many: string }, total: number, c: FanOutResult<unknown>['counts']): string {
  const parts = [`${c.ok} done`, c.partial ? `${c.partial} partial` : '', c.failed ? `${c.failed} failed` : ''].filter(Boolean)
  return `${verb} ${total} ${total === 1 ? noun.one : noun.many} (${parts.join(', ')})`
}
