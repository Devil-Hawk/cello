// Tests for standing preferences — the durable "what you told Cello you want"
// list injected into every copilot planning call.
//
// The behaviours worth pinning are the ones that decide whether the feature
// helps or slowly poisons the prompt: dedupe (a user repeating themselves must
// not consume the cap), eviction order (drop the stalest, never the newest),
// and defensive reads (this comes out of a jsonb column that anything could
// have written).

import { describe, expect, it } from 'vitest'
import {
  MAX_PREFERENCE_LENGTH,
  MAX_STANDING_PREFERENCES,
  PreferenceError,
  addStandingPreference,
  formatStandingPreferences,
  readStandingPreferences,
  removeStandingPreference,
  type StandingPreference,
} from './standing-preferences'

const AT = (iso: string) => new Date(iso)

function pref(text: string, recordedAt = '2026-07-01T00:00:00.000Z'): StandingPreference {
  return { text, recordedAt }
}

describe('addStandingPreference', () => {
  it('records a preference', () => {
    const out = addStandingPreference([], 'Series A+ startups only', AT('2026-07-29T10:00:00.000Z'))
    expect(out).toEqual([
      { text: 'Series A+ startups only', recordedAt: '2026-07-29T10:00:00.000Z' },
    ])
  })

  it('treats a restatement as emphasis, not a new fact', () => {
    // The exact failure this guards: a user says "Series A+ only", it does not
    // stick, they say it again — and now the list holds it twice and the cap
    // fills with one repeated opinion.
    const first = addStandingPreference([], 'Series A+ only', AT('2026-07-01T00:00:00.000Z'))
    const second = addStandingPreference(first, 'series a+ only.', AT('2026-07-29T00:00:00.000Z'))
    expect(second).toHaveLength(1)
    // The restatement wins: newer wording, newer timestamp.
    expect(second[0]).toEqual({ text: 'series a+ only.', recordedAt: '2026-07-29T00:00:00.000Z' })
  })

  it('moves a restated preference to the end so it is not next to be evicted', () => {
    let list = addStandingPreference([], 'A', AT('2026-07-01T00:00:00.000Z'))
    list = addStandingPreference(list, 'B', AT('2026-07-02T00:00:00.000Z'))
    list = addStandingPreference(list, 'A', AT('2026-07-03T00:00:00.000Z'))
    expect(list.map((p) => p.text)).toEqual(['B', 'A'])
  })

  it('evicts the OLDEST when over the cap, never the newest', () => {
    let list: StandingPreference[] = []
    for (let i = 0; i < MAX_STANDING_PREFERENCES + 3; i++) {
      list = addStandingPreference(list, `pref ${i}`, AT(`2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`))
    }
    expect(list).toHaveLength(MAX_STANDING_PREFERENCES)
    expect(list[0].text).toBe('pref 3')
    expect(list[list.length - 1].text).toBe(`pref ${MAX_STANDING_PREFERENCES + 2}`)
  })

  it('rejects an empty or whitespace-only preference', () => {
    expect(() => addStandingPreference([], '   ')).toThrow(PreferenceError)
  })

  it('rejects a paragraph, and says how long it actually was', () => {
    const long = 'x'.repeat(MAX_PREFERENCE_LENGTH + 1)
    expect(() => addStandingPreference([], long)).toThrow(/under 200 characters/)
    // The message has to carry the real number or the model cannot self-correct.
    expect(() => addStandingPreference([], long)).toThrow(new RegExp(String(MAX_PREFERENCE_LENGTH + 1)))
  })

  it('accepts a preference exactly at the length limit', () => {
    const exact = 'y'.repeat(MAX_PREFERENCE_LENGTH)
    expect(addStandingPreference([], exact)[0].text).toHaveLength(MAX_PREFERENCE_LENGTH)
  })
})

describe('readStandingPreferences — this comes out of a jsonb column', () => {
  it('returns [] for anything that is not a list', () => {
    for (const junk of [null, undefined, {}, { standingPreferences: 'nope' }, { standingPreferences: 42 }]) {
      expect(readStandingPreferences(junk)).toEqual([])
    }
  })

  it('skips malformed entries instead of throwing', () => {
    const out = readStandingPreferences({
      standingPreferences: [
        null,
        'a bare string',
        { recordedAt: '2026-07-01T00:00:00.000Z' },
        { text: '   ' },
        { text: 'Series A+ only', recordedAt: '2026-07-01T00:00:00.000Z' },
      ],
    })
    expect(out).toEqual([{ text: 'Series A+ only', recordedAt: '2026-07-01T00:00:00.000Z' }])
  })

  it('supplies a timestamp when one is missing rather than dropping the preference', () => {
    // A preference with a lost timestamp is still a preference; losing the text
    // over a missing date would be the wrong trade.
    const out = readStandingPreferences({ standingPreferences: [{ text: 'No relocation' }] })
    expect(out).toHaveLength(1)
    expect(out[0].recordedAt).toBe(new Date(0).toISOString())
  })

  it('dedupes on read, so a row corrupted by an older writer self-heals', () => {
    const out = readStandingPreferences({
      standingPreferences: [
        { text: 'Series A+ only', recordedAt: '2026-07-01T00:00:00.000Z' },
        { text: 'series a+ only', recordedAt: '2026-07-02T00:00:00.000Z' },
      ],
    })
    expect(out).toHaveLength(1)
  })

  it('enforces the cap on read as well as on write', () => {
    const many = Array.from({ length: 40 }, (_, i) => pref(`p${i}`))
    expect(readStandingPreferences({ standingPreferences: many })).toHaveLength(MAX_STANDING_PREFERENCES)
  })

  it('truncates an over-long stored preference rather than rejecting the whole read', () => {
    const out = readStandingPreferences({ standingPreferences: [{ text: 'z'.repeat(500) }] })
    expect(out[0].text).toHaveLength(MAX_PREFERENCE_LENGTH)
  })
})

describe('removeStandingPreference', () => {
  it('removes by text, ignoring case and punctuation', () => {
    const list = [pref('Series A+ only'), pref('No relocation')]
    expect(removeStandingPreference(list, 'series a+ only.').map((p) => p.text)).toEqual(['No relocation'])
  })

  it('is a no-op for something not stored', () => {
    const list = [pref('Series A+ only')]
    expect(removeStandingPreference(list, 'something else')).toHaveLength(1)
  })
})

describe('formatStandingPreferences', () => {
  it('renders nothing at all for an empty list', () => {
    // An empty "what this user told you" header is a claim that they told you
    // nothing, which is different from having no record.
    expect(formatStandingPreferences([])).toBe('')
  })

  it('lists every preference and forbids silently ignoring one', () => {
    const out = formatStandingPreferences([pref('Series A+ only'), pref('No big tech')])
    expect(out).toContain('- Series A+ only')
    expect(out).toContain('- No big tech')
    // The conflict instruction is the load-bearing half: without it the model
    // can honour a new request by quietly dropping a standing preference.
    expect(out).toMatch(/never quietly ignore/i)
  })
})
