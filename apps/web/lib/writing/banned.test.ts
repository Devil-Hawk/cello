import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMAIL_PHRASES, findBannedPhrases, VOICE_BUZZWORDS, VOICE_FILLER } from './banned'

const voice = readFileSync(join(process.cwd(), 'prompts', '_voice.md'), 'utf8')

function itemText(from: string, to: string): string {
  const start = voice.indexOf(from)
  const end = voice.indexOf(to, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return voice.slice(start, end)
}

describe('banned phrases', () => {
  it('has every buzzword from _voice.md item 2', () => {
    const block = itemText('2. **Banned buzzwords**', 'This ban')
    const words = block
      .replace(/^2\. \*\*Banned buzzwords\*\*/, '')
      .replace(/\([^)]*\)/g, '')
      .split(',')
      .map((w) => w.replace(/^[^a-z]+/i, '').replace(/[\s.*]+$/g, '').toLowerCase())
      .filter((w) => w && !w.includes(' use ') && w.length < 40)
    expect(words.length).toBeGreaterThan(15)
    for (const w of words) expect(VOICE_BUZZWORDS as readonly string[], `missing "${w}"`).toContain(w)
  })

  it('has every quoted filler opener and status phrase from _voice.md items 3 and 4', () => {
    const block = itemText('3. **Banned filler openers:**', '5. **Active voice')
    const quoted = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase())
    expect(quoted.length).toBe(9)
    for (const q of quoted) expect(VOICE_FILLER as readonly string[], `missing "${q}"`).toContain(q)
  })

  it('finds a banned phrase in any form and nothing in plain writing', () => {
    expect(findBannedPhrases('We leveraged Kafka and I am passionate about ledgers.')).toEqual(['leverage', 'passionate'])
    expect(findBannedPhrases('Just checking in on this.')).toEqual(['just checking in'])
    expect(findBannedPhrases('I came across your Payments role and I think it is a strong match.')).toEqual(['i came across', 'strong match'])
    expect(findBannedPhrases('I built the ledger at Halcyon Pay and cut reconciliation breaks by 92%.')).toEqual([])
    expect(EMAIL_PHRASES.length).toBe(6)
  })
})
