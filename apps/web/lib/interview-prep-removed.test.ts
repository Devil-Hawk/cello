// Interview prep was removed from Cello. This source test keeps it removed:
// it runs the same case-insensitive search the removal was checked with over
// the tracked source and fails on any hit outside the migrations (history,
// including the one that drops the table) and this file.
//
// The one allowed line is a job-title word in lib/jobs/classify.ts ("Agile
// Coach"), which has nothing to do with the retired feature.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(process.cwd(), '../..')

const RETIRED =
  'interview_prep|interview_kits|interview ?kit|prep_interview|interviewTips|interview prep|interview tips|/prep\\b|coach([^i]|$)|prep ?kit|star stor|kitId|questionCount|prep/\\[id\\]'

// Recorded third-party pages and postings (the reader's fixtures and the ingest eval) say "coach" and "interview" in their own words.
const ALLOWED = [
  /^apps\/web\/lib\/jobs\/classify\.ts:\d+:\s+'professor', 'tutor', 'coach',/,
  /^apps\/web\/lib\/ingest\/reader\/__fixtures__\//,
  /^apps\/web\/lib\/ingest\/reader\/detail\.test\.ts:/,
  /^apps\/web\/scripts\/eval-ingest\/(pages|postings)/,
  // Recorded postings of real employers used by the shortlist and output evaluations.
  /^apps\/web\/scripts\/eval-shortlist\/data\/jobs\.json:/,
  /^apps\/web\/scripts\/evals\/outputs\/data\/jobs\.json:/,
  /^apps\/web\/scripts\/evals\/quality\/data\/jobs\.json:/,
]

function hits(): string[] {
  try {
    const out = execFileSync(
      'git',
      [
        'grep', '-n', '-i', '-E', RETIRED, '--',
        'apps', 'scripts', 'supabase', '.github',
        ':!supabase/migrations',
        ':!apps/web/lib/interview-prep-removed.test.ts',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    return out.split('\n').filter(Boolean)
  } catch (e) {
    // git grep exits 1 when nothing matches.
    if ((e as { status?: number }).status === 1) return []
    throw e
  }
}

describe('interview prep stays removed', () => {
  it('finds no trace of it outside the migrations', () => {
    const left = hits().filter((line) => !ALLOWED.some((re) => re.test(line)))
    expect(left).toEqual([])
  })

  it('still sees the one allowed job-title word, so the search itself is live', () => {
    expect(hits().some((line) => ALLOWED.some((re) => re.test(line)))).toBe(true)
  })
})
