import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryStore, MemorySaver } from '@langchain/langgraph'
import { DemoAccessError, demoSessionGate } from '@/lib/access/guardrails'
import { AGENT_COPY } from './copy'
import { createCelloAgent } from './factory'
import { MAX_RESUMES, handleContinue, occurrenceBrief, MISSED_AFTER_MS, type ContinueDeps } from './occurrences'
import type { RunnableAgent } from './run'
import { claimLease } from './scheduler'
import { makeFakeAdmin } from './testing/fake-admin'
import { ScriptedChatModel, say } from './testing/scripted-model'

const PAST = (ms: number) => new Date(Date.now() - ms).toISOString()

function world(task: Record<string, unknown> = {}) {
  const admin = makeFakeAdmin(
    {
      profiles: [{ id: 'u1', email: 'dana@example.com', is_demo: false, demo_expires_at: null, full_name: 'Dana', resume_text: '', preferences: {} }],
      copilot_conversations: [{ id: 'conv1', user_id: 'u1', title: 'Morning roles', thread_id: null, scheduled_task_id: 's1' }],
      graph_threads: [],
      agent_tasks: [],
      approvals: [],
      scheduled_tasks: [
        {
          id: 's1',
          user_id: 'u1',
          name: 'Morning roles',
          instruction: 'Find new product roles in Austin.',
          cron: '0 8 * * *',
          timezone: 'UTC',
          autonomy: 'draft',
          rules: {},
          status: 'active',
          template: null,
          conversation_id: 'conv1',
          next_run_at: PAST(60_000),
          last_run_at: null,
          last_status: null,
          last_result: null,
          poked_at: null,
          created_at: PAST(86_400_000),
          ...task,
        },
      ],
    },
    {
      graph_threads: { defaults: () => ({ thread_id: crypto.randomUUID(), lease_until: null, lease_holder: null, expires_at: null }) },
      agent_tasks: { defaults: () => ({ status: 'queued', artifact_ids: [], caps: null }) },
      approvals: { defaults: () => ({ posted_at: null }) },
    }
  )
  return { admin, saver: new MemorySaver(), store: new InMemoryStore(), skillsDir: mkdtempSync(path.join(tmpdir(), 'cello-occ-')) }
}

type W = ReturnType<typeof world>

function deps(w: W, model: ScriptedChatModel, extra: Record<string, unknown> = {}): { fire: ReturnType<typeof vi.fn<[], Promise<undefined>>>; deps: ContinueDeps } {
  const fire = vi.fn(async () => undefined)
  return {
    fire,
    deps: {
      loadKeys: async () => ({ openrouter: 'k', userId: 'u1', isDemo: false }) as never,
      turn: {
        persistence: { saver: w.saver, store: w.store, close: async () => undefined } as never,
        mcp: { tools: [], skipped: [], close: async () => undefined },
        fire,
        card: '',
        buildAgent: (input: never) => createCelloAgent({ ...(input as object), model, fallbacks: [], skillsDir: w.skillsDir } as never) as unknown as RunnableAgent,
      },
      ...extra,
    } as unknown as ContinueDeps,
  }
}

const model = (...lines: string[]) => new ScriptedChatModel({ model: 'qwen/qwen3.8-27b:free', script: lines.map((l) => say(l)) })
const task = (w: W) => w.admin.tables.scheduled_tasks[0]
const roots = (w: W) => w.admin.tables.agent_tasks.filter((t) => t.parent_id === null)

async function savedMessages(w: W, threadId: string, m: ScriptedChatModel) {
  const agent = createCelloAgent({ kind: 'orchestrator', ctx: { admin: w.admin, userId: 'u1', userEmail: '', apiKeys: { openrouter: 'k' }, isDemo: false, threadId, conversationId: null, autonomy: 'ask', traceId: 't', deadlineAt: Date.now() + 1e6 }, saver: w.saver, store: w.store, model: m, fallbacks: [], skillsDir: w.skillsDir } as never) as unknown as RunnableAgent
  return ((await agent.getState({ configurable: { thread_id: threadId } })).values?.messages ?? []).map((x) => String(x.content))
}

describe('a due scheduled task', () => {
  it('runs on its own thread, named for the task, and records how it went', async () => {
    const w = world()
    const m = model('Found 3 product roles in Austin.')
    const { deps: d } = deps(w, m)
    const out = await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, d)
    expect(out).toEqual({ kind: 'ran', outcome: 'done' })

    // One scheduled thread, tied to the task's conversation, and a lease that was let go.
    expect(w.admin.tables.graph_threads.filter((t) => t.surface === 'scheduled')).toHaveLength(1)
    expect(w.admin.tables.graph_threads.find((t) => t.surface === 'scheduled')).toMatchObject({ user_id: 'u1', conversation_id: 'conv1', lease_until: null })
    expect(roots(w)).toHaveLength(1)
    expect(roots(w)[0]).toMatchObject({ agent: 'cello', title: 'Morning roles', status: 'done', scheduled_task_id: 's1', conversation_id: 'conv1' })

    // The model was told what to do, and that nobody is there to answer.
    const sent = m.calls[0].map((x) => String(x.content)).join('\n')
    expect(sent).toContain('Find new product roles in Austin.')
    expect(sent).toContain('The person is away')

    // The card: ok, with the result, and the next time moved ahead.
    expect(task(w)).toMatchObject({ last_status: 'ok', last_result: 'Found 3 product roles in Austin.', poked_at: null })
    expect(new Date(task(w).next_run_at as string).getTime()).toBeGreaterThan(Date.now())
    expect(task(w).last_run_at).toBeTruthy()
  })

  it('leaves the result in the task conversation, where the person can ask about it', async () => {
    const w = world()
    await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(w, model('Found 3 roles.')).deps)
    const convo = w.admin.tables.copilot_conversations[0]
    expect(convo.thread_id).toBeTruthy()
    expect(w.admin.tables.graph_threads.find((t) => t.thread_id === convo.thread_id)).toMatchObject({ surface: 'agent', conversation_id: 'conv1', lease_until: null })
    expect(await savedMessages(w, convo.thread_id as string, model())).toEqual(['Found 3 roles.'])

    // The next thing the person says is read with that result before it.
    const follow = model('The first one is the best fit.')
    const agent = createCelloAgent({ kind: 'orchestrator', ctx: { admin: w.admin, userId: 'u1', userEmail: '', apiKeys: { openrouter: 'k' }, isDemo: false, threadId: convo.thread_id, conversationId: 'conv1', autonomy: 'ask', traceId: 't', deadlineAt: Date.now() + 1e6 }, saver: w.saver, store: w.store, model: follow, fallbacks: [], skillsDir: w.skillsDir } as never) as unknown as { invoke: (i: unknown, c: unknown) => Promise<unknown> }
    const { HumanMessage } = await import('@langchain/core/messages')
    await agent.invoke({ messages: [new HumanMessage('which one is best?')] }, { configurable: { thread_id: convo.thread_id } })
    const seen = follow.calls[0].map((x) => String(x.content))
    expect(seen).toContain('Found 3 roles.')
    expect(seen.at(-1)).toBe('which one is best?')
    expect(follow.calls).toHaveLength(1)
  })

  it('two requests for the same occurrence run it once', async () => {
    const w = world()
    const m = model('Done once.', 'Done twice.')
    const { deps: d } = deps(w, m)
    const [a, b] = await Promise.all([handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, d), handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, d)])
    expect([a.kind, b.kind].sort()).toEqual(['ignored', 'ran'])
    expect(m.calls).toHaveLength(1)
    expect(roots(w)).toHaveLength(1)
  })

  it('does nothing when it is not due yet, or is paused', async () => {
    const w = world({ next_run_at: new Date(Date.now() + 3_600_000).toISOString() })
    const m = model('x')
    expect(await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(w, m).deps)).toEqual({ kind: 'ignored', why: 'not_due' })
    const p = world({ status: 'paused', next_run_at: null })
    expect(await handleContinue(p.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(p, m).deps)).toEqual({ kind: 'ignored', why: 'paused' })
    expect(m.calls).toHaveLength(0)
    expect(roots(w)).toHaveLength(0)
  })

  it('Run now works on a task that is not due, even a paused one, and leaves its schedule alone', async () => {
    const next = new Date(Date.now() + 3_600_000).toISOString()
    const w = world({ next_run_at: next, status: 'paused' })
    const out = await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', force: true, exp: 0 }, deps(w, model('Ran now.')).deps)
    expect(out).toEqual({ kind: 'ran', outcome: 'done' })
    expect(task(w)).toMatchObject({ next_run_at: next, status: 'paused', last_status: 'ok' })
  })

  it('a task that was due more than twelve hours ago is marked missed, not run at the wrong time', async () => {
    const w = world({ next_run_at: PAST(MISSED_AFTER_MS + 3_600_000) })
    const m = model('x')
    expect(await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(w, m).deps)).toEqual({ kind: 'missed' })
    expect(m.calls).toHaveLength(0)
    expect(task(w).last_status).toBe('missed')
    expect(new Date(task(w).next_run_at as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('a missing key ends it as failed, in words, and lets go of the thread', async () => {
    const w = world()
    const { deps: d } = deps(w, model('x'), {
      loadKeys: async () => {
        throw new DemoAccessError(demoSessionGate(null))
      },
    })
    expect(await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, d)).toEqual({ kind: 'ran', outcome: 'failed' })
    expect(task(w)).toMatchObject({ last_status: 'failed', last_result: AGENT_COPY.demoExpired })
    expect(w.admin.tables.graph_threads.every((t) => t.lease_until === null)).toBe(true)
  })

  it("someone else's task id is an unknown task, and an unknown id does nothing", async () => {
    const w = world()
    expect(await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 'nope', exp: 0 }, deps(w, model('x')).deps)).toEqual({ kind: 'ignored', why: 'unknown' })
    expect(await handleContinue(w.admin, { reason: 'due', exp: 0 }, deps(w, model('x')).deps)).toEqual({ kind: 'ignored', why: 'unknown' })
    expect(await handleContinue(w.admin, { reason: 'slice', exp: 0 }, deps(w, model('x')).deps)).toEqual({ kind: 'ignored', why: 'unknown' })
  })

  it('the brief names the task and the instruction, and uses no engine words', () => {
    const brief = occurrenceBrief({ name: 'Morning roles', instruction: 'Find roles.' })
    expect(brief).toContain('"Morning roles"')
    expect(brief).toContain('Find roles.')
    expect(brief).not.toMatch(/\b(run|thread|tick|graph)\b/i)
  })
})

describe('slices and stalled work', () => {
  it('a slice leaves the task working, and the continuation finishes it and records the result', async () => {
    const w = world()
    const m = model('Finished after the handover.')
    const first = deps(w, m, { deadlineAt: Date.now() - 1000 })
    expect(await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, first.deps)).toEqual({ kind: 'ran', outcome: 'slice' })
    const threadId = w.admin.tables.graph_threads.find((t) => t.surface === 'scheduled')!.thread_id as string
    expect(first.fire).toHaveBeenCalledWith({ reason: 'slice', thread_id: threadId })
    expect(roots(w)[0].status).toBe('working')
    // The card does not say it finished, because it has not.
    expect(task(w).last_status).toBeNull()
    expect(m.calls).toHaveLength(0)

    const second = deps(w, m)
    expect(await handleContinue(w.admin, { reason: 'slice', thread_id: threadId, exp: 0 }, second.deps)).toEqual({ kind: 'ran', outcome: 'done' })
    expect(m.calls).toHaveLength(1)
    expect(roots(w)).toHaveLength(1)
    expect(roots(w)[0].status).toBe('done')
    expect(task(w)).toMatchObject({ last_status: 'ok', last_result: 'Finished after the handover.' })
    expect(w.admin.tables.copilot_conversations[0].thread_id).toBeTruthy()
  })

  it('ignores a continuation for work that already finished, and for a thread someone else is running', async () => {
    const w = world()
    await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(w, model('Done.')).deps)
    const threadId = w.admin.tables.graph_threads.find((t) => t.surface === 'scheduled')!.thread_id as string
    expect(await handleContinue(w.admin, { reason: 'slice', thread_id: threadId, exp: 0 }, deps(w, model('x')).deps)).toEqual({ kind: 'ignored', why: 'nothing_to_do' })

    const busy = world()
    await handleContinue(busy.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(busy, model('x'), { deadlineAt: Date.now() - 1000 }).deps)
    const tid = busy.admin.tables.graph_threads.find((t) => t.surface === 'scheduled')!.thread_id as string
    expect(await claimLease(busy.admin, tid)).not.toBeNull()
    expect(await handleContinue(busy.admin, { reason: 'slice', thread_id: tid, exp: 0 }, deps(busy, model('x')).deps)).toEqual({ kind: 'ignored', why: 'busy' })
  })

  it('stalled work is resumed from its saved step and counted, and given up on after five tries', async () => {
    const w = world()
    const m = model('Done after the crash.')
    // A request that died before doing anything: marked working, nobody holds the thread.
    const thread = await (async () => {
      const first = deps(w, m, { deadlineAt: Date.now() - 1000 })
      await handleContinue(w.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, first.deps)
      return w.admin.tables.graph_threads.find((t) => t.surface === 'scheduled')!.thread_id as string
    })()
    expect(await handleContinue(w.admin, { reason: 'stale', thread_id: thread, exp: 0 }, deps(w, m).deps)).toEqual({ kind: 'ran', outcome: 'done' })
    expect(roots(w)[0].caps).toMatchObject({ resumes: 1 })

    const g = world()
    await handleContinue(g.admin, { reason: 'due', scheduled_task_id: 's1', exp: 0 }, deps(g, model('x'), { deadlineAt: Date.now() - 1000 }).deps)
    const gt = g.admin.tables.graph_threads.find((t) => t.surface === 'scheduled')!.thread_id as string
    roots(g)[0].caps = { resumes: MAX_RESUMES }
    const gm = model('never')
    expect(await handleContinue(g.admin, { reason: 'stale', thread_id: gt, exp: 0 }, deps(g, gm).deps)).toEqual({ kind: 'ignored', why: 'gave_up' })
    expect(gm.calls).toHaveLength(0)
    expect(roots(g)[0]).toMatchObject({ status: 'failed', summary: AGENT_COPY.generic })
    expect(task(g)).toMatchObject({ last_status: 'failed', last_result: AGENT_COPY.generic })
    expect(g.admin.tables.graph_threads.every((t) => t.lease_until === null)).toBe(true)
  })

  it('a chat turn that stalled is resumed the same way, with no scheduled task to update', async () => {
    const w = world()
    w.admin.tables.graph_threads.push({ thread_id: 'chat1', user_id: 'u1', surface: 'agent', conversation_id: 'conv1', lease_until: null, lease_holder: null, expires_at: null })
    w.admin.tables.agent_tasks.push({ id: 'r1', user_id: 'u1', thread_id: 'chat1', conversation_id: 'conv1', parent_id: null, scheduled_task_id: null, agent: 'cello', title: 'x', status: 'working', caps: null, artifact_ids: [] })
    const out = await handleContinue(w.admin, { reason: 'stale', thread_id: 'chat1', exp: 0 }, deps(w, model('x')).deps)
    expect(out).toEqual({ kind: 'ran', outcome: 'done' })
    expect(w.admin.tables.agent_tasks[0].status).toBe('done')
    expect(task(w).last_status).toBeNull()
  })
})
