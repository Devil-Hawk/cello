import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { clock, TasksLine, workedSummary, type TaskRow } from './tasks-line'

const noop = () => undefined
const task = (n: number, over: Partial<TaskRow> = {}): TaskRow => ({ id: `w${n}`, title: `Research company ${n}`, status: 'working', command: 'companies.research', reads: 0, ...over })
const line = (tasks: TaskRow[], over: { running?: boolean; seconds?: number; defaultOpen?: boolean } = {}) =>
  renderToStaticMarkup(<TasksLine tasks={tasks} running={over.running ?? true} seconds={over.seconds ?? 42} onStop={noop} onStopTask={noop} defaultOpen={over.defaultOpen} />)
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('TasksLine', () => {
  it('counts the rows that finished, not the ones still going, with the clock', () => {
    const out = line([task(1, { status: 'done' }), task(2, { status: 'done' }), task(3), task(4, { status: 'queued' })])
    expect(text(out)).toContain('Cello is working: 2 of 4 done. 0:42')
    expect(out).toContain('>Show<')
    expect(out).toContain('>Stop<')
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

  it('shows nothing when there are no tasks', () => {
    expect(line([])).toBe('')
  })
})

describe('workedSummary and clock', () => {
  it('names unknown commands by count and says only the time when nothing finished', () => {
    expect(workedSummary([task(1, { status: 'done', command: 'something.else' })], 5)).toBe('Worked 0:05: finished 1 task.')
    expect(workedSummary([task(1, { status: 'stopped' })], 5)).toBe('Worked 0:05.')
    expect(clock(125)).toBe('2:05')
  })
})
