import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RungInfo } from '@/lib/chat/settings'
import { choiceWords, ModelPicker } from './model-picker'

const FREE = 'qwen/qwen3.8-27b:free'
const rungs: RungInfo[] = [
  { rung: 'R2', label: 'This computer', why: 'Not set up.', models: [] },
  { rung: 'R3', label: 'Free models', why: '', models: [{ id: FREE, label: 'qwen3.8-27b' }] },
  { rung: 'R4', label: 'Your own key', why: 'Above your highest. Change in Settings.', models: [{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' }] },
]
const choice = { rung: 'R3', model: FREE, effort: 'medium' } as const
const noop = () => undefined

describe('ModelPicker', () => {
  it('says the choice in words with its cost', () => {
    expect(choiceWords(choice, rungs)).toBe('Free models, Standard')
    const out = renderToStaticMarkup(<ModelPicker choice={choice} rungs={rungs} estimate="Free" onPick={noop} />)
    expect(out).toContain('Free models, Standard')
    expect(out).toContain('· Free')
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
})
