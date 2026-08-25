// Tests for lib/contacts/parse-csv.ts.
//
// The first describe block is the bug this module was extracted to fix: the old
// `line.split(',')` wrote a person's FIRST NAME into the email column and the
// UI then offered a Mail button for it. Everything else here exists so that
// cannot come back by a different route.

import { describe, expect, it } from 'vitest'
import { looksLikeEmail, parseContactsCsv, splitCsvRows } from './parse-csv'

const HEADER = 'name,email,company,title'

describe('the quoted-comma corruption that motivated this module', () => {
  it('keeps a "Last, First" name and its email in the right columns', () => {
    const csv = `${HEADER}\n"Smith, Jane",jane@acme.com,Acme,"Engineer, ML"`
    const { rows, rejected } = parseContactsCsv(csv)

    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Smith, Jane')
    // The old parser produced 'Jane' here and then rendered mailto:Jane.
    expect(rows[0].email).toBe('jane@acme.com')
    expect(rows[0].title).toBe('Engineer, ML')
    expect(rows[0].company).toBe('Acme')
    expect(rejected).toEqual([])
  })

  it('never lets a non-email reach the email field, even if a parse goes wrong', () => {
    // Defence in depth: if any future change re-introduces column shifting,
    // the shape check still stops "Jane" from becoming a send target.
    const csv = `${HEADER}\nJane Smith,Jane,Acme,Engineer`
    const { rows, rejected } = parseContactsCsv(csv)

    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Jane Smith')
    expect(rows[0].email).toBeNull()
    expect(rejected).toEqual([
      { line: 2, name: 'Jane Smith', value: 'Jane', reason: 'not a valid email address' },
    ])
  })

  it('imports the person even when their address is unusable', () => {
    // Dropping the whole row would silently lose a real contact over one cell.
    const csv = `${HEADER}\nJane Smith,not-an-email,Acme,Engineer`
    const { rows } = parseContactsCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBeNull()
    expect(rows[0].title).toBe('Engineer')
  })
})

describe('splitCsvRows', () => {
  it('handles a comma inside quotes', () => {
    expect(splitCsvRows('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('handles a newline inside quotes without starting a new row', () => {
    expect(splitCsvRows('a,"line one\nline two",c')).toEqual([['a', 'line one\nline two', 'c']])
  })

  it('treats a doubled quote as one literal quote', () => {
    expect(splitCsvRows('a,"she said ""hi""",c')).toEqual([['a', 'she said "hi"', 'c']])
  })

  it('handles CRLF line endings', () => {
    expect(splitCsvRows('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('handles a lone CR', () => {
    expect(splitCsvRows('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('does not invent a trailing row for a file that ends in a newline', () => {
    expect(splitCsvRows('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps a trailing row that has no line terminator', () => {
    expect(splitCsvRows('a,b\nc,d')).toHaveLength(2)
  })

  it('preserves empty fields rather than collapsing them', () => {
    expect(splitCsvRows('a,,c')).toEqual([['a', '', 'c']])
  })

  it('strips a UTF-8 BOM so the first header still matches', () => {
    // Excel writes one; without stripping it the first column is named
    // "﻿name" and the name lookup fails on an otherwise valid file.
    const rows = splitCsvRows('﻿name,email\nJane,jane@acme.com')
    expect(rows[0][0]).toBe('name')
  })

  it('keeps a stray mid-field quote verbatim instead of swallowing it', () => {
    expect(splitCsvRows('a,5" pipe,c')).toEqual([['a', '5" pipe', 'c']])
  })
})

describe('header handling', () => {
  it('reports a missing name column', () => {
    const result = parseContactsCsv('email,title\njane@acme.com,Engineer')
    expect(result.missingNameColumn).toBe(true)
    expect(result.rows).toEqual([])
  })

  it('is case- and whitespace-insensitive about header names', () => {
    const { rows } = parseContactsCsv(' Name , EMAIL \nJane Smith,jane@acme.com')
    expect(rows[0]).toMatchObject({ name: 'Jane Smith', email: 'jane@acme.com' })
  })

  it('accepts either linkedin or linkedin_url', () => {
    expect(parseContactsCsv('name,linkedin\nJane,https://x.test/j').rows[0].linkedin_url).toBe(
      'https://x.test/j'
    )
    expect(parseContactsCsv('name,linkedin_url\nJane,https://x.test/j').rows[0].linkedin_url).toBe(
      'https://x.test/j'
    )
  })

  it('distinguishes a header-only file from a broken one', () => {
    // Previously this returned the same shape as "no name column", so the
    // dialog showed no preview, no error, and no explanation at all.
    const result = parseContactsCsv(HEADER)
    expect(result.headerOnly).toBe(true)
    expect(result.missingNameColumn).toBe(false)
    expect(result.empty).toBe(false)
  })

  it('distinguishes an empty file', () => {
    expect(parseContactsCsv('   \n  ').empty).toBe(true)
    expect(parseContactsCsv('').empty).toBe(true)
  })
})

describe('row handling', () => {
  it('skips rows with no name', () => {
    const { rows } = parseContactsCsv(`${HEADER}\n,orphan@acme.com,Acme,Engineer\nJane,j@acme.com,Acme,Eng`)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Jane')
  })

  it('skips a trailing blank line without reporting it as a rejection', () => {
    const { rows, rejected } = parseContactsCsv(`${HEADER}\nJane,j@acme.com,Acme,Eng\n`)
    expect(rows).toHaveLength(1)
    expect(rejected).toEqual([])
  })

  it('caps the preview at 5 but imports every row', () => {
    const body = Array.from({ length: 40 }, (_, i) => `Person ${i},p${i}@acme.com,Acme,Eng`).join('\n')
    const { rows, preview } = parseContactsCsv(`${HEADER}\n${body}`)
    expect(rows).toHaveLength(40)
    expect(preview).toHaveLength(5)
  })

  it('survives emoji and non-Latin names intact', () => {
    const { rows } = parseContactsCsv(`${HEADER}\n🎉 Priya Raman,priya@acme.com,Acme,Eng\n田中太郎,tanaka@acme.co.jp,Acme,Eng`)
    expect(rows[0].name).toBe('🎉 Priya Raman')
    expect(rows[1].name).toBe('田中太郎')
    expect(rows[1].email).toBe('tanaka@acme.co.jp')
  })

  it('handles a quoted newline inside a name without losing the following row', () => {
    const csv = `${HEADER}\n"Jane\nSmith",jane@acme.com,Acme,Eng\nBob,bob@acme.com,Acme,Eng`
    const { rows } = parseContactsCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('Jane\nSmith')
    expect(rows[1].name).toBe('Bob')
  })

  it('tolerates a short row missing trailing columns', () => {
    const { rows } = parseContactsCsv(`${HEADER}\nJane,jane@acme.com`)
    expect(rows[0]).toMatchObject({ name: 'Jane', email: 'jane@acme.com', company: null, title: null })
  })

  it('reports the original line number for a rejected address', () => {
    const csv = `${HEADER}\nA,a@acme.com,Acme,Eng\nB,bogus,Acme,Eng`
    expect(parseContactsCsv(csv).rejected[0].line).toBe(3)
  })
})

describe('looksLikeEmail', () => {
  it.each(['jane@acme.com', 'j.doe+tag@sub.acme.co.uk', 'tanaka@acme.co.jp'])('accepts %s', (v) => {
    expect(looksLikeEmail(v)).toBe(true)
  })

  it.each([
    ['Jane', 'the exact corruption the old parser produced'],
    ['Acme', 'a company name shifted into the email column'],
    ['', 'blank'],
    ['@acme.com', 'no local part'],
    ['jane@', 'no domain'],
    ['jane@acme', 'no dot in the domain'],
    ['jane@@acme.com', 'two at signs'],
    ['jane doe@acme.com', 'whitespace'],
    ['jane@.com', 'domain starts with a dot'],
    ['jane@acme.', 'domain ends with a dot'],
  ])('rejects %j — %s', (value) => {
    expect(looksLikeEmail(value)).toBe(false)
  })
})
