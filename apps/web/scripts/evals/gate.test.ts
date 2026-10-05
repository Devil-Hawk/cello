// The eval gate's decisions: which suites a change runs, how exit codes read,
// that a run without a model key skips cleanly, and that no eval script can
// exist without a suite naming it.

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  entryScripts,
  expandScripts,
  gateFails,
  globToRegExp,
  matchesAny,
  outcomeForExit,
  selectSuites,
  summaryMarkdown,
  toWebRelative,
  unlistedScripts,
  type Manifest,
} from './lib/gate-core'

const WEB = process.cwd()
const manifest = JSON.parse(readFileSync(path.join(WEB, 'scripts/evals/gate.json'), 'utf8')) as Manifest
const names = (changed: string[]) => selectSuites(manifest, changed).map((s) => s.name)

describe('globs', () => {
  it('* stays inside a folder, ** crosses folders, a trailing slash is a whole folder', () => {
    expect(globToRegExp('prompts/*.md').test('prompts/analyst.md')).toBe(true)
    expect(globToRegExp('prompts/*.md').test('prompts/sub/analyst.md')).toBe(false)
    expect(globToRegExp('lib/**').test('lib/a/b/c.ts')).toBe(true)
    expect(globToRegExp('lib/memory/').test('lib/memory/mem0-store.ts')).toBe(true)
    expect(globToRegExp('lib/memory/').test('lib/memory2/x.ts')).toBe(false)
    expect(globToRegExp('a.b').test('aXb')).toBe(false)
  })
})

describe('selectSuites', () => {
  it('a prompt change runs the suite that owns it and nothing else', () => {
    expect(names(['apps/web/prompts/analyst.md'])).toEqual(['quality'])
    expect(names(['apps/web/prompts/outreach.md'])).toEqual(['outputs'])
    expect(names(['apps/web/lib/scoring/chance.ts'])).toEqual(['scoring'])
  })

  it('a change to the policy or the prompt assembly runs every suite', () => {
    const all = manifest.suites.map((s) => s.name)
    expect(names(['apps/web/prompts/_policy.md'])).toEqual(all)
    expect(names(['apps/web/lib/harness/prompts.ts'])).toEqual(all)
  })

  it('files outside apps/web, and code no suite covers, run nothing', () => {
    expect(names(['README.md', 'docs/PROMPT-POLICY.md', '.github/workflows/ci.yml'])).toEqual([])
    expect(names(['apps/web/components/ui/button.tsx'])).toEqual([])
  })

  it('several changes select each suite once', () => {
    expect(names(['apps/web/prompts/analyst.md', 'apps/web/lib/quality/health.ts', 'apps/web/prompts/outreach.md'])).toEqual(['quality', 'outputs'])
  })

  it('toWebRelative strips the app folder only', () => {
    expect(toWebRelative('apps/web/prompts/a.md')).toBe('prompts/a.md')
    expect(toWebRelative('docs/a.md')).toBeNull()
  })
})

describe('scripts and results', () => {
  it('globs expand against what exists, and a suite with no script is reported as missing', () => {
    const files = ['scripts/evals/outputs/outreach.ts', 'scripts/evals/outputs/lib/runner.ts', 'scripts/evals/outputs/outreach.test.ts', 'scripts/evals/quality/run.ts']
    const out = expandScripts({ name: 'o', scripts: ['scripts/evals/outputs/*.ts', 'scripts/evals/agent/run-*.ts'], paths: [] }, files)
    expect(out.found).toEqual(['scripts/evals/outputs/outreach.ts'])
    expect(out.missing).toEqual(['scripts/evals/agent/run-*.ts'])
  })

  it('exit 0 passes, 1 is a regression, anything else is a broken script', () => {
    expect(outcomeForExit(0)).toBe('pass')
    expect(outcomeForExit(1)).toBe('regression')
    expect(outcomeForExit(2)).toBe('error')
    expect(outcomeForExit(null)).toBe('error')
    expect(gateFails(['pass', 'skipped', 'not present'])).toBe(false)
    expect(gateFails(['pass', 'regression'])).toBe(true)
    expect(gateFails(['error'])).toBe(true)
  })

  it('the job summary lists every row', () => {
    const md = summaryMarkdown([{ suite: 'quality', script: 'scripts/evals/quality/run.ts', outcome: 'pass', seconds: 41 }])
    expect(md).toContain('| quality | `scripts/evals/quality/run.ts` | pass | 41 |')
  })
})

describe('run-gate without a model key', () => {
  it('prints that it skipped and exits 0, without touching git or running a suite', () => {
    const env = { ...process.env }
    delete env.OPENROUTER_API_KEY
    delete env.GITHUB_STEP_SUMMARY
    const res = spawnSync('npx', ['--yes', 'tsx', 'scripts/evals/run-gate.ts', '--base', 'origin/does-not-exist'], { cwd: WEB, env, encoding: 'utf8', timeout: 120_000 })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Skipped: no model key on this run')
  }, 130_000)
})

describe('the manifest', () => {
  it('has a positive request budget and only suites with a script and a path', () => {
    expect(manifest.maxRequestsPerRun).toBeGreaterThan(0)
    for (const s of manifest.suites) {
      expect(s.scripts.length, s.name).toBeGreaterThan(0)
      expect(s.paths.length, s.name).toBeGreaterThan(0)
    }
  })

  it('every eval entry script is named by a suite', () => {
    expect(unlistedScripts(manifest, entryScripts(WEB)), 'add the script to scripts/evals/gate.json, or move a helper into lib/').toEqual([])
  })

  it('the scanner sees an unlisted script (mutation guard)', () => {
    expect(unlistedScripts(manifest, ['scripts/evals/new-thing.ts', 'scripts/eval-new.ts'])).toEqual(['scripts/evals/new-thing.ts', 'scripts/eval-new.ts'])
    expect(matchesAny('scripts/evals/quality/run.ts', manifest.suites.flatMap((s) => s.scripts))).toBe(true)
  })

  it('the workflow runs on pull requests only (never pull_request_target) and passes the key as a secret', () => {
    const yml = readFileSync(path.join(WEB, '../../.github/workflows/eval-gate.yml'), 'utf8')
    expect(yml).toMatch(/^on:\s*\n\s+pull_request:/m)
    expect(yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toContain('pull_request_target')
    expect(yml).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}')
    expect(yml).toContain('contents: read')
  })
})
