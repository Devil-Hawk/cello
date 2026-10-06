import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { addRead, finishWorker, MAX_READS, openWorker, requestStop, requestStopWorker, runWorkers, type WorkerScope } from './workers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const caps = { steps: 10, ms: 30_000, tokens: 10_000 }
const setup = () => {
  const db = makeFakeAdmin({ agent_tasks: [] })
  const scope: WorkerScope = { db, userId: 'u1', threadId: 'th1', chatId: 'c1', turnId: 't1', model: 'free:free', rung: 'R3' }
  return { db, scope }
}
const rows = (db: ReturnType<typeof setup>['db']) => [...db.tables.agent_tasks].sort((a, b) => Number(a.branch_index) - Number(b.branch_index))
const companies = ['Ramp', 'Linear', 'Vercel', 'Retool']

describe('runWorkers', () => {
  it('writes one row per branch whose state and reads match what the branch did', async () => {
    const { db, scope } = setup()
    const out = await runWorkers(scope, {
      command: 'companies.research',
      items: companies,
      titleOf: (c) => `Research ${c}`,
      objectOf: (c) => ({ kind: 'company', ref: c }),
      caps,
      deadlineAt: Date.now() + 60_000,
      async worker(c, b) {
        for (let i = 0; i <= companies.indexOf(c); i++) await b.read({ label: `${c} careers ${i}`, url: `https://${c}.test/${i}` })
        return c
      },
    })
    expect(out.counts).toEqual({ ok: 4, partial: 0, failed: 0 })
    const table = rows(db)
    expect(table).toHaveLength(4)
    table.forEach((row, i) => {
      expect(row).toMatchObject({ user_id: 'u1', chat_id: 'c1', turn_id: 't1', thread_id: 'th1', command: 'companies.research', status: 'done', title: `Research ${companies[i]}`, object: { kind: 'company', ref: companies[i] }, model: 'free:free', rung: 'R3' })
      expect((row.reads as unknown[]).length).toBe(i + 1)
      expect(row.finished_at).toBeTruthy()
    })
  })

  it('stops one branch: no tool call after its stop, the other three finish', async () => {
    const { db, scope } = setup()
    const log: string[] = []
    await runWorkers(scope, {
      command: 'companies.research',
      items: companies,
      titleOf: (c) => `Research ${c}`,
      caps,
      deadlineAt: Date.now() + 60_000,
      async worker(c, b) {
        const mine = companies.indexOf(c)
        for (let step = 1; step <= 3; step++) {
          await b.checkStop()
          log.push(`tool:${mine}`)
          if (mine === 1 && step === 1) {
            log.push('stop:1')
            expect(await requestStopWorker(db, 'u1', b.taskId as string)).toBe(true)
          }
          await sleep(5)
        }
        return c
      },
    })
    const after = log.slice(log.indexOf('stop:1') + 1)
    expect(after).not.toContain('tool:1')
    expect(log.filter((l) => l === 'tool:1')).toHaveLength(1)
    for (const other of [0, 2, 3]) expect(log.filter((l) => l === `tool:${other}`)).toHaveLength(3)
    expect(rows(db).map((r) => r.status)).toEqual(['done', 'stopped', 'done', 'done'])
  })

  it('aborts a fetch in flight when its worker is stopped', async () => {
    const { db, scope } = setup()
    const started = Date.now()
    await runWorkers(scope, {
      command: 'companies.research',
      items: ['Ramp'],
      titleOf: (c) => c,
      caps,
      deadlineAt: Date.now() + 60_000,
      pollMs: 10,
      async worker(_c, b) {
        setTimeout(() => void requestStopWorker(db, 'u1', b.taskId as string), 30)
        await new Promise((_resolve, reject) => b.signal.addEventListener('abort', () => reject(new Error('fetch aborted'))))
        return null
      },
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rows(db)[0].status).toBe('stopped')
  })

  it('does not let one failure end the others', async () => {
    const { db, scope } = setup()
    const out = await runWorkers(scope, {
      command: 'companies.research',
      items: companies,
      titleOf: (c) => c,
      caps,
      deadlineAt: Date.now() + 60_000,
      async worker(c) {
        if (c === 'Vercel') throw new Error('board unreachable')
        return c
      },
    })
    expect(out.counts).toEqual({ ok: 3, partial: 0, failed: 1 })
    expect(rows(db).map((r) => r.status)).toEqual(['done', 'done', 'failed', 'done'])
    expect(rows(db)[2].summary).toBe('board unreachable')
  })
})

describe('stop requests', () => {
  it('refuse a task id that is not the person\'s, a missing one, and a finished one', async () => {
    const { db, scope } = setup()
    const mine = await openWorker(scope, { command: 'companies.research', title: 'Ramp' })
    const done = await openWorker(scope, { command: 'companies.research', title: 'Linear' })
    await finishWorker(db, done, { status: 'done' })
    expect(await requestStopWorker(db, 'u2', mine as string)).toBe(false)
    expect(await requestStopWorker(db, 'u1', '00000000-0000-4000-8000-000000000000')).toBe(false)
    expect(await requestStopWorker(db, 'u1', done as string)).toBe(false)
    expect(db.tables.agent_tasks.every((r) => !r.stop_requested_at)).toBe(true)
    expect(await requestStopWorker(db, 'u1', mine as string)).toBe(true)
  })

  it('stops every unfinished row of the turn and no other turn', async () => {
    const { db, scope } = setup()
    await openWorker(scope, { command: 'companies.research', title: 'Ramp' })
    await openWorker(scope, { command: 'companies.research', title: 'Linear' })
    const done = await openWorker(scope, { command: 'companies.research', title: 'Vercel' })
    await finishWorker(db, done, { status: 'done' })
    await openWorker({ ...scope, turnId: 't2' }, { command: 'companies.research', title: 'Other turn' })
    expect(await requestStop(db, 'u1', 't1')).toBe(2)
    expect(db.tables.agent_tasks.filter((r) => r.stop_requested_at).map((r) => r.title).sort()).toEqual(['Linear', 'Ramp'])
    expect(await requestStop(db, 'u2', 't1')).toBe(0)
  })
})

describe('addRead', () => {
  it('keeps the first 50 reads and drops the rest', async () => {
    const { db, scope } = setup()
    const id = await openWorker(scope, { command: 'companies.research', title: 'Ramp' })
    for (let i = 0; i < MAX_READS + 10; i++) await addRead(db, id, { label: `read ${i}`, row: { table: 'jobs', id: String(i) } })
    const reads = db.tables.agent_tasks[0].reads as { label: string }[]
    expect(reads).toHaveLength(MAX_READS)
    expect(reads[0].label).toBe('read 0')
  })
})
