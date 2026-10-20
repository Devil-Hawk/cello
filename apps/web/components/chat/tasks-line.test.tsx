import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { clock, TasksLine, workedSummary, type TaskRow } from './tasks-line'

const noop = () => undefined
const task = (n: number, over: Partial<TaskRow> = {}): TaskRow => ({ id: `w${n}`, title: `Research company ${n}`, status: 'working', command: 'companies.research', reads: 0, ...over })
const line = (tasks: TaskRow[], over: { running?: boolean; seconds?: number; defaultOpen?: boolean; stopping?: boolean; background?: boolean } = {}) =>
  renderToStaticMarkup(<TasksLine tasks={tasks} running={over.running ?? true} seconds={over.seconds ?? 42} onStop={noop} onStopTask={noop} defaultOpen={over.defaultOpen} stopping={over.stopping} background={over.background} />)
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('TasksLine', () => {
  it('counts the rows that finished, not the ones still going, with the clock', () => {
    const out = line([task(1, { status: 'done' }), task(2, { status: 'done' }), task(3), task(4, { status: 'queued' })])
    expect(text(out)).toContain('Cello is working: 2 of 4 done. 0:42')
    expect(out).toContain('>Show<')
    expect(out).toContain('>Stop<')
  })

  it('does not count a removed step as work', () => {
    const removed = task(9, { status: 'stopped', command: 'chat.plan.step', summary: 'Removed by you' })
    expect(text(line([task(1, { status: 'queued', command: 'chat.plan.step' }), task(2), removed]))).toContain('Cello is working: 0 of 2 done.')
  })

  it('shows Stopped for a worker row whose summary is the library error', () => {
    const row = task(1, { status: 'stopped', command: 'applications.start', summary: 'This operation was aborted' })
    expect(text(line([row], { defaultOpen: true }))).toContain('Research company 1 Stopped')
    expect(text(line([row], { defaultOpen: true }))).not.toContain('aborted')
    const plan = task(2, { status: 'stopped', command: 'chat.plan.step', summary: 'Removed by you' })
    expect(text(line([plan], { defaultOpen: true }))).toContain('Removed by you')
  })

  it('lists each task with its state, its reads and a Stop for the ones still going only', () => {
    const out = line([task(1, { status: 'done', reads: 3 }), task(2, { status: 'stopped' }), task(3, { status: 'failed' }), task(4, { reads: 1 })], { defaultOpen: true })
    expect(text(out)).toContain('Research company 1 Done 3 pages read')
    expect(text(out)).toContain('Stopped')
    expect(text(out)).toContain('Could not finish')
    expect(text(out)).toContain('1 page read')
    expect((out.match(/aria-label="Stop: /g) ?? []).length).toBe(1)
    expect(out).toContain('aria-label="Stop: Research company 4"')
  })

  it('folds to what was done once the turn ends, with no Stop', () => {
    const out = line([task(1, { status: 'done' }), task(2, { status: 'done' }), task(3, { status: 'stopped' }), task(4, { status: 'done', command: 'documents.draft' })], { running: false, seconds: 41 })
    expect(text(out)).toContain('Worked 0:41: researched 2 companies, drafted 1 draft.')
    expect(out).not.toContain('>Stop<')
  })

  it('shows nothing when there are no tasks and the turn is over', () => {
    expect(line([], { running: false })).toBe('')
  })

  it('says only that Cello is working, with Stop and nothing to show, while a turn runs with no work rows', () => {
    const out = line([], { running: true, seconds: 7 })
    expect(text(out)).toContain('Cello is working. 0:07')
    expect(out).toContain('>Stop<')
    expect(out).not.toContain('>Show<')
    expect(out).not.toContain('of 0 done')
  })
})

describe('TasksLine with a plan', () => {
  it('says Planned for a planned row and Removed by you for a removed one', () => {
    const out = text(line([
      task(1, { status: 'queued', command: 'chat.plan.step', title: 'Start an application: Engineer at Ramp' }),
      task(2, { status: 'stopped', command: 'chat.plan.step', summary: 'Removed by you', title: 'Write a cover letter' }),
      task(3, { status: 'failed', command: 'chat.plan.step', summary: 'raw error text', title: 'Research: Ramp' }),
    ], { defaultOpen: true }))
    expect(out).toContain('Start an application: Engineer at Ramp Planned')
    expect(out).toContain('Write a cover letter Removed by you')
    expect(out).toContain('Research: Ramp Could not finish')
    expect(out).not.toContain('raw error text')
  })

  it('shows an added row as added after the plan started', () => {
    const out = text(line([task(1, { status: 'done', command: 'chat.plan.added', summary: 'Added after the plan started', title: 'Added: Write a cover letter' })], { defaultOpen: true }))
    expect(out).toContain('Added: Write a cover letter Added after the plan started')
  })

  it('does not claim work for a plan that never began', () => {
    expect(workedSummary([task(1, { status: 'stopped', command: 'chat.plan.step', summary: 'Cancelled by you' })], 2)).toBe('Nothing was started.')
  })

  it('leaves plan rows out of what was done', () => {
    expect(workedSummary([task(1, { status: 'done', command: 'chat.plan' }), task(2, { status: 'done', command: 'chat.plan.step' }), task(3, { status: 'done', command: 'chat.plan.added' })], 5)).toBe('Worked 0:05.')
  })
})

describe('TasksLine while stopping', () => {
  it('reads Stopping instead of the clock and rests the Stop key without dropping focus', () => {
    const out = line([], { running: true, seconds: 7, stopping: true })
    expect(text(out)).toContain('Stopping')
    expect(text(out)).not.toContain('0:07')
    expect(out).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Stop<\/button>/)
  })

  it('reads Stopping with work rows too', () => {
    expect(text(line([task(1), task(2, { status: 'done' })], { stopping: true }))).not.toContain('of 2 done')
  })
})

describe('workedSummary and clock', () => {
  it('names unknown commands by count and says only the time when nothing finished', () => {
    expect(workedSummary([task(1, { status: 'done', command: 'something.else' })], 5)).toBe('Worked 0:05: finished 1 task.')
    expect(workedSummary([task(1, { status: 'stopped' })], 5)).toBe('Worked 0:05.')
    expect(clock(125)).toBe('2:05')
  })
})

describe('TasksLine in the background', () => {
  it('says the turn carries on in the background with Stop while it runs without the page', () => {
    const none = line([], { background: true, seconds: 7 })
    expect(text(none)).toContain('Cello carries on in the background. You can leave this page. 0:07')
    expect(none).toContain('>Stop<')
    expect(none).toContain('role="status"')
    expect(none).toContain('aria-live="polite"')
    const rows = line([task(1, { status: 'done' }), task(2), task(3, { status: 'queued' })], { background: true })
    expect(text(rows)).toContain('Cello carries on in the background: 1 of 3 done. You can leave this page. 0:42')
    expect(rows).toContain('>Show<')
    expect(rows).toContain('>Stop<')
    expect(text(rows)).not.toContain('Cello is working')
  })

  it('reads Stopping, not the background line, once Stop is pressed', () => {
    const out = text(line([task(1)], { background: true, stopping: true }))
    expect(out).toContain('Stopping')
    expect(out).not.toContain('background')
  })

  it('folds to what was done when the turn is over, whatever background says', () => {
    expect(text(line([task(1, { status: 'done' })], { running: false, background: true, seconds: 41 }))).toContain('Worked 0:41: researched 1 company.')
  })

  it('keeps the plain working line when background is not set', () => {
    expect(text(line([], { seconds: 7 }))).toContain('Cello is working. 0:07')
  })
})
