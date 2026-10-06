/** A file that still makes a raw model call, and why. The lane that owns the file
 *  moves the call behind a defineModelStep step and deletes the entry in the same
 *  commit; the source test fails on an entry whose file no longer makes the call. */
export interface AllowEntry {
  /** Relative to apps/web, with forward slashes. */
  file: string
  reason: string
  /** Survives the strict rule: a file that holds the scanner's own patterns as text. */
  permanent?: boolean
}
