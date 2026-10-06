import { describe, expect, it, vi } from 'vitest'
import { Command, MemorySaver, StateGraph, Annotation, START, END, interrupt } from '@langchain/langgraph'
import { BudgetCapError } from '@/lib/harness/spend'
import { MAX_CONCURRENCY, PartialValue, fanOut, summarizeCounts, type BranchEvent } from './fanout'

const caps = { steps: 8, ms: 5_000, tokens: 20_000 }
const farFuture = () => Date.now() + 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('fanOut', () => {
  it('runs at most four branches at once, and uses all four', async () => {
    let alive = 0
    let peak = 0
    const res = await fanOut({
      items: [1, 2, 3, 4, 5, 6, 7],
      caps,
      deadlineAt: farFuture(),
      worker: async (n) => {
        alive += 1
        peak = Math.max(peak, alive)
        await sleep(30)
        alive -= 1
        return n * 2
      },
    })
    expect(peak).toBe(MAX_CONCURRENCY)
    expect(res.results.map((r) => r.value)).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(res.counts).toEqual({ ok: 7, partial: 0, failed: 0 })
  })

  it('cannot be asked for more than four at once', async () => {
    let alive = 0
    let peak = 0
    await fanOut({
      items: Array.from({ length: 10 }, (_, i) => i),
      caps,
      deadlineAt: farFuture(),
      maxConcurrency: 50,
      worker: async () => {
        alive += 1
        peak = Math.max(peak, alive)
        await sleep(20)
        alive -= 1
      },
    })
    expect(peak).toBe(4)
  })

  it('one failing branch does not sink the others', async () => {
    const res = await fanOut({
      items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      caps,
      deadlineAt: farFuture(),
      worker: async (x) => {
        if (x === 'd') throw new Error('site was down')
        return x.toUpperCase()
      },
    })
    expect(res.counts).toEqual({ ok: 6, partial: 0, failed: 1 })
    expect(res.results[3]).toMatchObject({ index: 3, status: 'failed', error: 'site was down' })
    expect(res.results[0]).toMatchObject({ status: 'ok', value: 'A' })
  })

  it('a branch past its time cap is partial for time, and the rest finish', async () => {
    const res = await fanOut({
      items: ['fast', 'slow', 'fast2'],
      caps: { ...caps, ms: 50 },
      deadlineAt: farFuture(),
      worker: async (x, b) => {
        if (x !== 'slow') return x
        await new Promise((_, reject) => b.signal.addEventListener('abort', () => reject(b.signal.reason)))
      },
    })
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'partial', 'ok'])
    expect(res.results[1].reason).toBe('time')
  })

  it('a branch that hits the budget is partial for budget', async () => {
    const res = await fanOut({
      items: [1, 2],
      caps,
      deadlineAt: farFuture(),
      worker: async (n) => {
        if (n === 2) throw new BudgetCapError(10, 10)
        return n
      },
    })
    expect(res.results[1]).toMatchObject({ status: 'partial', reason: 'budget' })
    expect(res.results[0].status).toBe('ok')
  })

  it('a worker can hand back what it has with the reason it stopped', async () => {
    const res = await fanOut({
      items: ['x'],
      caps,
      deadlineAt: farFuture(),
      worker: async () => new PartialValue('steps', { found: 2 }),
    })
    expect(res.results[0]).toEqual({ index: 0, status: 'partial', reason: 'steps', value: { found: 2 } })
  })

  it('past the deadline no new branch starts', async () => {
    const worker = vi.fn(async (n: number) => n)
    const res = await fanOut({ items: [1, 2, 3], caps, deadlineAt: Date.now() - 1, worker })
    expect(worker).not.toHaveBeenCalled()
    expect(res.results.every((r) => r.status === 'partial' && r.reason === 'time')).toBe(true)
  })

  it('the deadline arriving mid-run stops the branches that have not started', async () => {
    const started: number[] = []
    const res = await fanOut({
      items: Array.from({ length: 8 }, (_, i) => i),
      caps,
      deadlineAt: Date.now() + 30,
      worker: async (n) => {
        started.push(n)
        await sleep(80)
        return n
      },
    })
    // The first four start at once; the next four wait for a slot and find the deadline passed.
    expect(started.length).toBe(4)
    expect(res.counts.ok).toBe(4)
    expect(res.counts.partial).toBe(4)
  })

  it('reports every branch start and end once', async () => {
    const events: BranchEvent<string, string>[] = []
    await fanOut<string, string>({
      items: ['a', 'b'],
      caps,
      deadlineAt: farFuture(),
      onBranch: (e) => void events.push(e),
      worker: async (x) => x,
    })
    expect(events.filter((e) => e.phase === 'start')).toHaveLength(2)
    expect(events.filter((e) => e.phase === 'end')).toHaveLength(2)
  })

  it('a task-tree writer that throws does not fail the branch', async () => {
    const res = await fanOut({
      items: ['a'],
      caps,
      deadlineAt: farFuture(),
      onBranch: () => {
        throw new Error('realtime is down')
      },
      worker: async (x) => x,
    })
    expect(res.results[0].status).toBe('ok')
  })

  it('an empty list is an empty result', async () => {
    expect(await fanOut({ items: [], caps, deadlineAt: farFuture(), worker: async () => 1 })).toEqual({
      results: [],
      counts: { ok: 0, partial: 0, failed: 0 },
    })
  })

  it('a graph interrupt inside a branch is not swallowed as a failure', async () => {
    const State = Annotation.Root({ out: Annotation<string>() })
    const saver = new MemorySaver()
    const outer = new StateGraph(State)
      .addNode('work', async () => {
        const r = await fanOut({
          items: [1],
          caps,
          deadlineAt: farFuture(),
          worker: async () => interrupt({ kind: 'question' }) as Promise<string>,
        })
        return { out: String(r.results[0].value) }
      })
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile({ checkpointer: saver })
    const config = { configurable: { thread_id: 'fan-int' } }
    const first = (await outer.invoke({}, config)) as { __interrupt__?: unknown[] }
    expect(first.__interrupt__).toBeTruthy()
    const done = await outer.invoke(new Command({ resume: 'answer' }), config)
    expect(done.out).toBe('answer')
  })
})

describe('summarizeCounts', () => {
  it('reads like the task tree line', () => {
    const companies = { one: 'company', many: 'companies' }
    expect(summarizeCounts('Researching', companies, 6, { ok: 4, partial: 1, failed: 1 })).toBe(
      'Researching 6 companies (4 done, 1 partial, 1 failed)'
    )
    expect(summarizeCounts('Researching', companies, 1, { ok: 1, partial: 0, failed: 0 })).toBe('Researching 1 company (1 done)')
  })
})
