// Kept apart from health.ts so the dashboard card (a client component) can read the line
// without pulling in the server-only code health.ts uses.
const MB = 1024 * 1024

/** The report warns past this size. The free plan stops at 500 MB. */
export const DB_WARN_BYTES = 350 * MB
export const DB_LIMIT_BYTES = 500 * MB
