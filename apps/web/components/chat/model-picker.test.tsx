import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RungInfo } from '@/lib/chat/settings'
import { choiceWords, ModelPicker, steppedDownWords } from './model-picker'

const FREE = 'qwen/qwen3.8-27b:free'
const rungs: RungInfo[] = [
  { rung: 'R2', label: 'This computer', why: 'Not set up.', models: [] },
  { rung: 'R3', label: 'Free models', why: '', models: [{ id: FREE, label: 'qwen3.8-27b' }, { id: 'laguna/laguna-s-2.1:free', label: 'laguna-s-2.1' }] },
  { rung: 'R4', label: 'Your own key', why: 'Above your highest. Change in Settings.', models: [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' }] },
]
const choice = { rung: 'R3', model: FREE, effort: 'medium' } as const
const noop = () => undefined

describe('ModelPicker', () => {
  it('says the choice in words with its cost', () => {
    expect(choiceWords(choice, rungs)).toBe('Free models: qwen3.8-27b, Standard')
    const out = renderToStaticMarkup(<ModelPicker choice={choice} rungs={rungs} estimate="Free" onPick={noop} />)
    expect(out).toContain('Free models: qwen3.8-27b, Standard')
    expect(out).toContain('· Free')
    // The phone's summary is the model's name alone; the rung, effort and cost wait in the opened ladder.
    expect(out).toMatch(/<summary[^>]*><span class="truncate sm:hidden">qwen3.8-27b<\/span>/)
    expect(out).toMatch(/class="[^"]*sm:hidden"[^>]*>Free models: qwen3.8-27b, Standard · Free</)
  })

  it('greys a rung above the highest, with the reason, and one that is not set up', () => {
    const out = renderToStaticMarkup(<ModelPicker choice={choice} rungs={rungs} onPick={noop} />)
    expect(out).toContain('Above your highest. Change in Settings.')
    expect(out).toContain('Not set up.')
    expect((out.match(/disabled=""/g) ?? []).length).toBe(2)
  })

  it('offers the three ways to apply a choice, and Deeper only on the person\'s own key', () => {
    const out = renderToStaticMarkup(<ModelPicker choice={choice} rungs={rungs} onPick={noop} />)
    expect(out).toContain('Use in this chat')
    expect(out).toContain('Just this message')
    expect(out).toContain('Use for new chats')
    expect(out).not.toContain('Deeper')
    expect(renderToStaticMarkup(<ModelPicker choice={{ rung: 'R4', model: 'anthropic/claude-sonnet-5', effort: 'high' }} rungs={rungs} onPick={noop} />)).toContain('Deepest')
  })

  it('says the last answer stepped down, in words the page shows outside the picker', () => {
    const lastRan = { rung: 'R3' as const, model: 'laguna/laguna-s-2.1:free', effort: 'medium' as const, steppedDown: { wanted: choice, why: 'model' as const } }
    expect(steppedDownWords(lastRan, choice, rungs)).toBe('Your last answer came from laguna-s-2.1: qwen3.8-27b did not answer.')
    // Once the person picks what answered, or the choice answered itself, there is nothing to say.
    expect(steppedDownWords(lastRan, { ...choice, model: lastRan.model }, rungs)).toBe('')
    expect(steppedDownWords({ ...choice }, choice, rungs)).toBe('')
    expect(steppedDownWords(null, choice, rungs)).toBe('')
  })
})
