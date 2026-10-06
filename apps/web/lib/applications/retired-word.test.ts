// The word for what was sent is "attempt". The old word leaves the product (owner directive 21), so
// this scan fails on it anywhere in apps or scripts, outside the migrations (which keep history).
//
// The allow list is exactly the files that are not this lane's, the two aliases that keep them
// working, and the old routes. Each entry goes when its owner moves on.
// ponytail: allow list, emptied by PG5 (the pipeline dialogs) and the K9 sweep (the rest).

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(process.cwd(), '../..')

const ALLOWED = [
  // not ours: PG5 moves the pipeline dialogs; the others are other lanes' or third-party text
  'apps/web/components/pipeline/application-card.tsx',
  'apps/web/components/pipeline/application-detail-dialog.test.tsx',
  'apps/web/components/pipeline/application-detail-dialog.tsx',
  'apps/web/components/pipeline/log-application-dialog.tsx',
  'apps/web/components/dashboard/gmail-sync-card.tsx',
  'apps/web/lib/outreach/store.ts',
  'apps/web/lib/ingest/reader/__fixtures__/google-robots.txt',
  // ours, kept for one release so the dialogs above keep working
  'apps/web/lib/applications/receipts.ts',
  'apps/web/lib/applications/types.ts',
  'apps/web/app/api/applications/receipts/route.ts',
  'apps/web/app/api/applications/receipts/[id]/route.ts',
  // this test
  'apps/web/lib/applications/retired-word.test.ts',
]

function git(args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
  } catch (e) {
    // git grep exits 1 when nothing matches.
    if ((e as { status?: number }).status === 1) return []
    throw e
  }
}

describe('the retired word', () => {
  it('appears only in the allow list, in a file or in a path', () => {
    const inFiles = git(['grep', '-l', '-i', 'receipt', '--', 'apps', 'scripts', ':!supabase/migrations'])
    const inPaths = git(['ls-files', 'apps', 'scripts']).filter((f) => /receipt/i.test(f))
    const hits = [...new Set([...inFiles, ...inPaths])].filter((f) => !ALLOWED.includes(f))
    expect(hits).toEqual([])
  })

  it('has no stale entry: every allowed file is still tracked', () => {
    const tracked = new Set(git(['ls-files', 'apps', 'scripts']))
    expect(ALLOWED.filter((f) => !tracked.has(f))).toEqual([])
  })
})
