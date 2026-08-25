// Quote-aware CSV parsing for contact import.
//
// WHY THIS FILE EXISTS
//   This logic used to live inline in components/contacts/csv-import.tsx and
//   split rows with `line.split(',')`. Given a perfectly ordinary export —
//
//     name,email,company,title
//     "Smith, Jane",jane@acme.com,Acme,"Engineer, ML"
//
//   that produced six fields instead of four, and every column shifted left of
//   the first quoted comma: name became "Smith" and **email became "Jane"**.
//   The contact then rendered a Mail button that opened `mailto:Jane`. On the
//   one surface whose entire purpose is contacting real human beings, silently
//   wrong addresses are the worst failure available, so the parser is now a
//   real character scanner living in a pure module that can be tested.
//
//   It is deliberately framework-free: no React, no DOM, no network.
//
// SCOPE
//   This handles the parts of RFC 4180 that real exports actually produce:
//   quoted fields, commas and newlines inside quotes, doubled quotes as an
//   escape, CRLF, and a UTF-8 BOM. It does not attempt to guess a delimiter —
//   comma only, which is what the dialog asks for.

/** One contact as parsed from a CSV row. `null` means the column was absent or blank. */
export interface CsvContactRow {
  name: string
  email: string | null
  title: string | null
  linkedin_url: string | null
  /**
   * Parsed but NOT yet imported. The dialog advertises and previews a company
   * column, and the insert path drops it because linking requires matching
   * against the user's companies table. Carried here so that fix is a join
   * away rather than a re-parse.
   */
  company: string | null
}

/** A data row we refused to import, and why — surfaced so the user is never silently edited. */
export interface RejectedRow {
  /** 1-based line number in the original file, counting the header. */
  line: number
  name: string
  value: string
  reason: string
}

export interface ParsedCsv {
  rows: CsvContactRow[]
  preview: Array<{ name: string; email: string; company: string; title: string }>
  missingNameColumn: boolean
  /** True when the file parsed but contained a header and no data rows. */
  headerOnly: boolean
  /** True when the file was empty or whitespace only. */
  empty: boolean
  rejected: RejectedRow[]
}

const PREVIEW_LIMIT = 5

/**
 * Split one CSV document into rows of raw fields.
 *
 * A single pass over the characters, because a line-based split cannot be
 * correct: a quoted field may legally contain the delimiter AND the line
 * separator, so "where does this row end" is only answerable while tracking
 * whether we are inside quotes.
 */
export function splitCsvRows(content: string): string[][] {
  // Strip a UTF-8 BOM; Excel writes one and it would otherwise become part of
  // the first header name, so `name` would never match.
  const text = content.replace(/^﻿/, '')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnyChar = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      // Only opens a quoted field at the start of one; a stray mid-field quote
      // is kept verbatim rather than silently swallowed.
      if (field.length === 0) {
        inQuotes = true
      } else {
        field += ch
      }
      sawAnyChar = true
      continue
    }

    if (ch === ',') {
      row.push(field)
      field = ''
      sawAnyChar = true
      continue
    }

    if (ch === '\r') {
      // CRLF or a lone CR both end the row; the LF (if any) is consumed next.
      if (text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAnyChar = false
      continue
    }

    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAnyChar = false
      continue
    }

    field += ch
    sawAnyChar = true
  }

  // Flush a trailing row that had no line terminator. A file ending in a
  // newline leaves nothing pending, which is why sawAnyChar is tracked.
  if (inQuotes || sawAnyChar || field.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * Is this string usable as an email address we would actually send to?
 *
 * Deliberately shape-only and permissive: the goal is catching the parser's own
 * corruption ("Jane", "Acme") and obvious junk, NOT adjudicating RFC 5322.
 * Over-rejecting a valid international address would be a worse failure than
 * letting an odd-looking one through, because the user can see and edit it.
 */
export function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@')
  if (at <= 0) return false
  if (value.indexOf('@', at + 1) !== -1) return false // more than one @
  if (/\s/.test(value)) return false
  const domain = value.slice(at + 1)
  if (domain.length < 3) return false
  if (!domain.includes('.')) return false
  if (domain.startsWith('.') || domain.endsWith('.')) return false
  return true
}

/** Trim a field and drop one layer of wrapping quotes the scanner already handled. */
function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

export function parseContactsCsv(content: string): ParsedCsv {
  const base: ParsedCsv = {
    rows: [],
    preview: [],
    missingNameColumn: false,
    headerOnly: false,
    empty: false,
    rejected: [],
  }

  if (!content.trim()) return { ...base, empty: true }

  const raw = splitCsvRows(content)
  if (raw.length === 0) return { ...base, empty: true }

  const headers = raw[0].map((h) => clean(h).toLowerCase())
  const nameIdx = headers.findIndex((h) => h === 'name')
  const emailIdx = headers.findIndex((h) => h === 'email')
  const companyIdx = headers.findIndex((h) => h === 'company')
  const titleIdx = headers.findIndex((h) => h === 'title')
  const linkedinIdx = headers.findIndex((h) => h === 'linkedin_url' || h === 'linkedin')

  if (nameIdx < 0) return { ...base, missingNameColumn: true }

  // A header-only file used to return the same shape as "no name column",
  // which meant the dialog showed no preview, no error, and no explanation.
  if (raw.length < 2) return { ...base, headerOnly: true }

  const rows: CsvContactRow[] = []
  const preview: ParsedCsv['preview'] = []
  const rejected: RejectedRow[] = []

  for (let i = 1; i < raw.length; i++) {
    const values = raw[i]
    // A trailing blank line parses to a single empty field; skip it silently
    // rather than reporting it as a rejection the user did nothing to cause.
    if (values.length === 1 && clean(values[0]) === '') continue

    const name = clean(values[nameIdx])
    if (!name) continue

    const rawEmail = emailIdx >= 0 ? clean(values[emailIdx]) : ''
    let email: string | null = null
    if (rawEmail) {
      if (looksLikeEmail(rawEmail)) {
        email = rawEmail
      } else {
        // Import the person, refuse the address. Dropping the whole row would
        // lose a real contact over one bad cell; keeping the address would let
        // a machine mail "Jane".
        rejected.push({
          line: i + 1,
          name,
          value: rawEmail,
          reason: 'not a valid email address',
        })
      }
    }

    rows.push({
      name,
      email,
      title: titleIdx >= 0 ? clean(values[titleIdx]) || null : null,
      linkedin_url: linkedinIdx >= 0 ? clean(values[linkedinIdx]) || null : null,
      company: companyIdx >= 0 ? clean(values[companyIdx]) || null : null,
    })

    if (preview.length < PREVIEW_LIMIT) {
      preview.push({
        name,
        email: rawEmail,
        company: companyIdx >= 0 ? clean(values[companyIdx]) : '',
        title: titleIdx >= 0 ? clean(values[titleIdx]) : '',
      })
    }
  }

  return { rows, preview, missingNameColumn: false, headerOnly: false, empty: false, rejected }
}
