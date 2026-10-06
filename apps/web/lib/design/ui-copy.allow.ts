// Screens that broke the copy rules before the scan in ui-copy.test.ts existed, with how many
// violations each has. A file listed here may not get worse; a file not listed may not have any.
// The sweep that rewrites these screens empties this list, one file at a time as each is clean.
//
// When the test fails, its message prints the current count for every file. Paste a file in
// here only on purpose, and never raise a count.

export const UI_COPY_BASELINE: Record<string, number> = {}
