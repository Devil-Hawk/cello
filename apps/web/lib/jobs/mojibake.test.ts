import { describe, expect, it } from 'vitest'
import { hasMojibake, repairMojibake } from './mojibake'

// The real corrupted text, copied out of the stored jobs row it was reported
// from (source=remoteok, "GenAI Engineer AI Builder…"). Written with \u
// escapes rather than pasted, because the C1 characters it contains
// (U+0080/U+0093) are invisible in an editor — the whole point of the bug.
//
// "9:00 AM â\u0080\u0093 6:00 PM" is the UTF-8 en dash E2 80 93 read as
// Latin-1; "Â·" is the middle dot C2 B7; "Â " is a non-breaking
// space C2 A0 whose A0 half a later whitespace-collapse turned into a space.
const CORRUPT_HOURS = 'Working Hours: 9:00 AM â\u0080\u0093 6:00 PM Â Local Time'
const CORRUPT_BULLETS = 'Product development Â· Â Â Â Design, build, and maintain'
const CORRUPT_EXPERIENCE = '1â\u0080\u00933 years of experience'
const CORRUPT_QUOTES = 'the companyâ\u0080\u0099s AI transformation'

describe('hasMojibake', () => {
  it('reports the real corrupted job-description samples as corrupted', () => {
    expect(hasMojibake(CORRUPT_HOURS)).toBe(true)
    expect(hasMojibake(CORRUPT_BULLETS)).toBe(true)
    expect(hasMojibake(CORRUPT_EXPERIENCE)).toBe(true)
    expect(hasMojibake(CORRUPT_QUOTES)).toBe(true)
  })

  it('reports the CP1252 flavour of the same corruption', () => {
    // Same bytes, misread through CP1252 instead of Latin-1: E2 80 99 -> "â€™".
    expect(hasMojibake('the companyâ€™s AI transformation')).toBe(true)
    expect(hasMojibake('1â€“3 years of experience')).toBe(true)
  })

  it('reports correct text as clean', () => {
    expect(hasMojibake('Working Hours: 9:00 AM – 6:00 PM Local Time')).toBe(false)
    expect(hasMojibake('Product development · Design, build, and maintain')).toBe(false)
    expect(hasMojibake("the company's AI transformation")).toBe(false)
    expect(hasMojibake('1–3 years of experience')).toBe(false)
    expect(hasMojibake('')).toBe(false)
    expect(hasMojibake(null)).toBe(false)
    expect(hasMojibake(undefined)).toBe(false)
  })

  it('reports legitimate accented/foreign text as clean', () => {
    // Every one of these contains a character the naive fix keys on ("Â", "â",
    // an accented capital) without being mojibake.
    expect(hasMojibake('Âge minimum : 18 ans')).toBe(false)
    expect(hasMojibake('Château, forêt, plâtre — bâtiment')).toBe(false)
    expect(hasMojibake('Añadir más experiencia en programación')).toBe(false)
    expect(hasMojibake('Ça va très bien')).toBe(false)
    expect(hasMojibake('Zürich · München · Köln')).toBe(false)
    expect(hasMojibake('Salary: €80,000 – €100,000')).toBe(false)
    expect(hasMojibake('«JOSÉ» — an accented capital before a guillemet')).toBe(false)
    expect(hasMojibake('Søk her, Ålesund, Ø, 25 °C')).toBe(false)
    expect(hasMojibake('日本語のテキスト')).toBe(false)
    expect(hasMojibake('Мы ищем инженера')).toBe(false)
    expect(hasMojibake('Ship it 🚀 today')).toBe(false)
  })
})

describe('repairMojibake', () => {
  it('reverses the real corrupted samples', () => {
    expect(repairMojibake(CORRUPT_HOURS)).toBe('Working Hours: 9:00 AM – 6:00 PM  Local Time')
    expect(repairMojibake(CORRUPT_BULLETS)).toBe('Product development ·    Design, build, and maintain')
    expect(repairMojibake(CORRUPT_EXPERIENCE)).toBe('1–3 years of experience')
    expect(repairMojibake(CORRUPT_QUOTES)).toBe('the company’s AI transformation')
  })

  it('reverses the CP1252 flavour too', () => {
    expect(repairMojibake('the companyâ€™s AI transformation')).toBe('the company’s AI transformation')
    expect(repairMojibake('cafÃ© â€“ Paris')).toBe('café – Paris')
  })

  it('round-trips: corrupt(correct) repairs back to exactly correct', () => {
    const samples = [
      'Working Hours: 9:00 AM – 6:00 PM Local Time',
      'Product development · Design, build, and maintain AI-powered workflows',
      '1–3 years of experience with “LLMs” and the company’s stack',
      'Zürich · München · Köln — 80.000 € … 100.000 €',
      'Мы ищем инженера — 日本語 — 🚀',
    ]
    for (const correct of samples) {
      // Corrupt it exactly the way the upstream aggregator does: encode UTF-8,
      // decode those bytes as Latin-1.
      const corrupted = Array.from(Buffer.from(correct, 'utf8'), (b) => String.fromCharCode(b)).join('')
      expect(corrupted).not.toBe(correct)
      expect(hasMojibake(corrupted)).toBe(true)
      expect(repairMojibake(corrupted)).toBe(correct)
    }
  })

  it('round-trips the other direction: correct text is returned untouched', () => {
    const clean = [
      'Working Hours: 9:00 AM – 6:00 PM Local Time',
      "the company's AI transformation",
      'Âge minimum : 18 ans',
      'Château, forêt, plâtre — bâtiment',
      'Añadir más experiencia en programación',
      '«JOSÉ» — an accented capital before a guillemet',
      'Salary: €80,000 – €100,000',
      'Søk her, Ålesund, Ø, 25 °C',
      'Zürich · München · Köln',
      '日本語のテキスト',
      'Ship it 🚀 today',
      'plain ascii description',
      '',
    ]
    for (const text of clean) {
      expect(repairMojibake(text)).toBe(text)
    }
  })

  it('is idempotent — repairing repaired text changes nothing', () => {
    for (const corrupt of [CORRUPT_HOURS, CORRUPT_BULLETS, CORRUPT_EXPERIENCE, CORRUPT_QUOTES]) {
      const once = repairMojibake(corrupt)
      expect(repairMojibake(once)).toBe(once)
    }
  })

  it('passes null/undefined straight through', () => {
    expect(repairMojibake(null)).toBe(null)
    expect(repairMojibake(undefined)).toBe(undefined)
  })

  it('repairs a real description without touching the surrounding prose', () => {
    const stored =
      'Employment Type: Full-time Contractor, Remote Working Hours: 9:00 AM â\u0080\u0093 6:00 PM Â ' +
      'Local Time About the Role We are looking for a proactiveÂ GenAI Engineer / AI Builder'
    expect(repairMojibake(stored)).toBe(
      'Employment Type: Full-time Contractor, Remote Working Hours: 9:00 AM – 6:00 PM  ' +
        'Local Time About the Role We are looking for a proactive GenAI Engineer / AI Builder'
    )
  })

  it('leaves an orphaned "Â" alone in text that is not otherwise mojibake', () => {
    // The stranded-NBSP cleanup is gated on the signature being present, so a
    // legitimate "Â " (French, or a stray) survives untouched.
    expect(repairMojibake('Â  is a lone letter here')).toBe('Â  is a lone letter here')
    expect(repairMojibake('Âge minimum : 18 ans')).toBe('Âge minimum : 18 ans')
  })

  it('never invents U+FFFD from a half-destroyed sequence', () => {
    // Naively re-encoding the whole string as Latin-1 and decoding as UTF-8
    // turns the collapsed "Â " into a replacement character. Repairing
    // sequence-by-sequence cannot.
    expect(repairMojibake(CORRUPT_HOURS)).not.toContain('�')
    expect(repairMojibake(CORRUPT_BULLETS)).not.toContain('�')
  })
})
