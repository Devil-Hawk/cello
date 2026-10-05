import { describe, expect, it } from 'vitest'
import { formatLines, jobLines, pickLines, resumeLines } from './lines'

describe('numbered lines', () => {
  it('splits on newlines and bullet glyphs, drops empties, keeps order', () => {
    const lines = resumeLines('Marcus\n\n- Built the ledger\n• Cut deploys to 6 minutes  ·  Mentored 4 engineers\n')
    expect(lines.map((l) => l.id)).toEqual(['R1', 'R2', 'R3', 'R4'])
    expect(lines.map((l) => l.text)).toEqual(['Marcus', 'Built the ledger', 'Cut deploys to 6 minutes', 'Mentored 4 engineers'])
  })

  it('never cuts a line in half and keeps lines past the cap out', () => {
    const lines = resumeLines('aaaa\nbbbb\ncccc', 9)
    expect(lines.map((l) => l.text)).toEqual(['aaaa', 'bbbb'])
  })

  it('keeps lines beyond the old 4,000 character cut', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Line ${i} ${'x'.repeat(30)}`).join('\n')
    expect(text.length).toBeGreaterThan(6000)
    expect(resumeLines(text).length).toBe(200)
  })

  it('numbers job text by sentence when a paragraph is long and decodes entities', () => {
    const para = `You will own payments&nbsp;risk. ${'Filler words go here. '.repeat(20)}Experience with Go is required.`
    const lines = jobLines(para)
    expect(lines.length).toBeGreaterThan(5)
    expect(lines[0]).toEqual({ id: 'J1', text: 'You will own payments risk.' })
    expect(lines[lines.length - 1].text).toBe('Experience with Go is required.')
  })

  it('formats and picks by id, dropping unknown ids', () => {
    const lines = resumeLines('one\ntwo\nthree')
    expect(formatLines(lines)).toBe('R1: one\nR2: two\nR3: three')
    expect(pickLines(lines, ['r3', 'R99', 'R1', 'R1']).map((l) => l.id)).toEqual(['R3', 'R1'])
    expect(pickLines(lines, 'R1')).toEqual([])
  })
})
