import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HANDS_OFF_WORD, hasKeyword, modeOfTask, modeWords, resolveMode, stripKeyword } from './mode'

describe('resolveMode', () => {
  it('turns hands-off on for the keyword only when Send for me is on', () => {
    expect(resolveMode({ typed: `apply to the Retell AI role ${HANDS_OFF_WORD}`, sendForMe: true })).toEqual({ mode: 'hands_off', why: 'keyword' })
    expect(resolveMode({ typed: `apply to the Retell AI role ${HANDS_OFF_WORD}`, sendForMe: false })).toEqual({ mode: 'ask', why: 'keyword', blocked: 'send_for_me_off' })
    expect(resolveMode({ typed: 'HandsOff, apply to it', sendForMe: true })).toEqual({ mode: 'hands_off', why: 'keyword' })
    // part of another word is not the keyword
    expect(resolveMode({ typed: 'my handsoffs are tied', sendForMe: true })).toEqual({ mode: 'ask', why: 'default' })
    expect(resolveMode({ typed: 'apply to it', sendForMe: true })).toEqual({ mode: 'ask', why: 'default' })
  })

  it('lets the chat override Settings', () => {
    expect(resolveMode({ chat: 'ask', settings: 'hands_off', sendForMe: true })).toEqual({ mode: 'ask', why: 'chat' })
    expect(resolveMode({ chat: 'hands_off', settings: 'ask', sendForMe: true })).toEqual({ mode: 'hands_off', why: 'chat' })
    expect(resolveMode({ chat: null, settings: 'hands_off', sendForMe: true })).toEqual({ mode: 'hands_off', why: 'settings' })
    // the keyword wins over both, for this turn
    expect(resolveMode({ typed: HANDS_OFF_WORD, chat: 'ask', settings: 'ask', sendForMe: true })).toEqual({ mode: 'hands_off', why: 'keyword' })
  })

  it('keeps a demo in Ask first, and a paused Cello too', () => {
    expect(resolveMode({ typed: HANDS_OFF_WORD, sendForMe: true, isDemo: true })).toEqual({ mode: 'ask', why: 'keyword', blocked: 'demo' })
    expect(resolveMode({ settings: 'hands_off', sendForMe: true, paused: true })).toEqual({ mode: 'ask', why: 'settings', blocked: 'paused' })
  })

  it('removes the keyword from what the model reads', () => {
    expect(stripKeyword(`apply to the Retell AI role ${HANDS_OFF_WORD}`)).toBe('apply to the Retell AI role')
    expect(stripKeyword(`${HANDS_OFF_WORD} apply to the Retell AI role`)).toBe('apply to the Retell AI role')
    expect(stripKeyword(`apply ${HANDS_OFF_WORD} to it.`)).toBe('apply to it.')
    expect(stripKeyword('apply to it')).toBe('apply to it')
    expect(hasKeyword(null)).toBe(false)
  })

  it('maps a scheduled task\'s autonomy: only act is hands-off', () => {
    expect(modeOfTask('act')).toBe('hands_off')
    expect(modeOfTask('draft')).toBe('ask')
    expect(modeOfTask(null)).toBe('ask')
  })

  it('says the mode and why in code\'s words', () => {
    expect(modeWords({ mode: 'hands_off', why: 'keyword' })).toBe(`Hands-off, because you typed ${HANDS_OFF_WORD}.`)
    expect(modeWords({ mode: 'ask', why: 'keyword', blocked: 'send_for_me_off' })).toBe('Ask first. Hands-off needs Send for me on.')
    expect(modeWords({ mode: 'ask', why: 'default' })).toBe('Ask first.')
    expect(modeWords({ mode: 'hands_off', why: 'chat' })).toBe('Hands-off, set for this chat.')
    expect(modeWords({ mode: 'ask', why: 'settings', blocked: 'demo' })).toBe('Ask first. This is a demo, so nothing is sent.')
  })
})

describe('the mode and the model are two controls', () => {
  it('never changes the model: the mode says nothing of one, and the module that decides it reads no model setting', () => {
    for (const typed of ['apply to it', `apply to it ${HANDS_OFF_WORD}`]) {
      for (const settings of ['ask', 'hands_off'] as const) {
        expect(Object.keys(resolveMode({ typed, settings, sendForMe: true })).filter((k) => !['mode', 'why', 'blocked'].includes(k))).toEqual([])
      }
    }
    expect(readFileSync('lib/chat/mode.ts', 'utf8')).not.toMatch(/lib\/models|choice|resolveChoice|roleChoice/)
  })
})
