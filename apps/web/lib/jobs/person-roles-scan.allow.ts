// Files that may still read `jobs` directly. A role is one shared row, so a person's reads go through
// person_roles (the person_jobs view, migration 20261008050001) and person-roles-scan.test.ts fails on
// any other `.from('jobs').select(`.

/** The scoring package (K8a) rewrites these two readers and then empties this list. */
export const K8A_READERS: readonly string[] = ['app/(app)/jobs/page.tsx', 'lib/harness/copilot-tools.ts']

/** The store reads its own employer's rows to diff a refresh; that is not a person's read. */
export const STORE_READERS: readonly string[] = ['lib/ats/store.ts']
