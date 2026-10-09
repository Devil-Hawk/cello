// The eval gate for pull requests.
//
//   cd apps/web && npx tsx scripts/evals/run-gate.ts --base origin/main [--all] [--dry-run]
//
// Looks at what the pull request changed, picks the suites in
// scripts/evals/gate.json that cover it, and runs each one on free models
// (EVAL_FREE_ONLY=1, ids ending in ":free"). A suite compares its own numbers
// with the thresholds.json next to it and exits 1 on a regression; any other
// non-zero exit is a broken script. The gate exits 1 when any suite regressed
// or broke.
//
// Without OPENROUTER_API_KEY (a pull request from a fork gets no secrets) it
// says so, writes that to the job summary and exits 0.
//
// ponytail: suites run one after another. If the gate ever needs more than the
// 150 free requests, run them in parallel jobs from a matrix instead.

import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  allScriptFiles,
  expandScripts,
  gateFails,
  outcomeForExit,
  selectSuites,
  summaryMarkdown,
  type Manifest,
  type Row,
} from './lib/gate-core'

const WEB = process.cwd()
const SKIP_NOTE = 'Skipped: no model key on this run'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function writeSummary(markdown: string): void {
  console.log(markdown)
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) appendFileSync(file, `${markdown}\n`)
}

function changedFiles(base: string): string[] {
  const out = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git diff against ${base} failed: ${out.stderr.trim()}`)
  return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

function main(): number {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    writeSummary(summaryMarkdown([], SKIP_NOTE))
    return 0
  }

  const manifest = JSON.parse(readFileSync(path.join(WEB, 'scripts/evals/gate.json'), 'utf8')) as Manifest
  const all = process.argv.includes('--all')
  const suites = all ? manifest.suites : selectSuites(manifest, changedFiles(arg('--base') ?? 'origin/main'))
  if (suites.length === 0) {
    writeSummary(summaryMarkdown([], 'No suite covers the files this pull request changes.'))
    return 0
  }

  const files = allScriptFiles(WEB)
  const plan = suites.map((suite) => ({ suite, ...expandScripts(suite, files) }))
  const scriptCount = plan.reduce((n, p) => n + p.found.length, 0)
  const perScript = Math.max(10, Math.floor(manifest.maxRequestsPerRun / Math.max(1, scriptCount)))

  if (process.argv.includes('--dry-run')) {
    for (const p of plan) console.log(`${p.suite.name}: ${p.found.join(', ') || '(not present)'}`)
    return 0
  }

  const rows: Row[] = []
  for (const { suite, found, missing } of plan) {
    for (const m of missing) rows.push({ suite: suite.name, script: m, outcome: 'not present' })
    for (const script of found) {
      const started = Date.now()
      const [cmd, cmdArgs] = script.endsWith('.sh')
        ? ['sh', [script, ...(suite.args ?? [])]]
        : ['npx', ['--yes', 'tsx', script, ...(suite.args ?? [])]]
      const res = spawnSync(cmd, cmdArgs, {
        cwd: WEB,
        stdio: 'inherit',
        timeout: 20 * 60_000,
        env: { ...process.env, EVAL_FREE_ONLY: '1', EVAL_MAX_REQUESTS: String(perScript) },
      })
      rows.push({ suite: suite.name, script, outcome: outcomeForExit(res.status), seconds: Math.round((Date.now() - started) / 1000) })
    }
  }

  const failed = gateFails(rows.map((r) => r.outcome))
  writeSummary(summaryMarkdown(rows, failed ? 'A suite regressed or broke. Its output is in the log above.' : undefined))
  return failed ? 1 : 0
}

process.exit(main())
