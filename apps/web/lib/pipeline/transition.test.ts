// The chokepoint: an application's state and its timeline are written by the SQL functions that
// transition.ts calls, and by nothing else. A direct write would skip the caps, Pause and the
// person-only kinds, so this scan fails on one anywhere in the app.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventJson } from './transition'

const ROOT = path.resolve(process.cwd(), '../..')
const files = execFileSync('git', ['ls-files', 'apps/web', 'scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.|__fixtures__|\/fixtures\//.test(f))

const EVENT_WRITE = /from\(\s*['"]pipeline_events['"]\s*\)\s*\.\s*(insert|upsert|update|delete)\b/
const STATE_WRITE = /from\(\s*['"]applications['"]\s*\)\s*\.\s*(insert|upsert|update)\(\s*\{[^}]*\bstate\s*:/

describe('the pipeline chokepoint', () => {
  it('writes pipeline_events and applications.state nowhere but the SQL functions', () => {
    const hits = files.filter((f) => {
      const src = readFileSync(path.join(ROOT, f), 'utf8')
      return EVENT_WRITE.test(src) || STATE_WRITE.test(src)
    })
    expect(hits).toEqual([])
  })

  it('sends the SQL the keys it reads', () => {
    expect(eventJson({ kind: 'step.finished', actor: 'schedule', sentence: 's', idempotencyKey: 'k', attemptInc: true, headerVerdict: { domain: 'a.com', dkim: 'pass' } })).toEqual({
      kind: 'step.finished',
      actor: 'schedule',
      sentence: 's',
      idempotency_key: 'k',
      attempt_inc: true,
      header_verdict: { domain: 'a.com', dkim: 'pass' },
    })
  })
})
