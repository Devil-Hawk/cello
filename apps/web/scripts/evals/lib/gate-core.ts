// The pure half of the pull request eval gate (scripts/evals/run-gate.ts):
// which suites a change should run, how a script's exit code reads, and which
// scripts count as eval entry points. No process, no git, no network here, so
// scripts/evals/gate.test.ts can check all of it.

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface Suite {
  name: string
  /** Paths relative to apps/web. A `*` matches within one folder, `**` across folders. */
  scripts: string[]
  args?: string[]
  /** A change to any of these (relative to apps/web) selects the suite. */
  paths: string[]
}

export interface Manifest {
  /** Free-model requests the whole gate may spend in one run. */
  maxRequestsPerRun: number
  /** A change to any of these selects every suite. */
  runAll: string[]
  suites: Suite[]
}

/** `*` within a folder, `**` across folders, everything else literal. A pattern
 *  ending in `/` matches everything under that folder. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith('/') ? `${glob}**` : glob
  let out = ''
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      out += '.*'
      i += 1
    } else if (c === '*') out += '[^/]*'
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

export function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(file))
}

/** Repo-relative path to apps/web-relative, or null for a file outside apps/web. */
export function toWebRelative(file: string): string | null {
  const norm = file.split(path.sep).join('/')
  return norm.startsWith('apps/web/') ? norm.slice('apps/web/'.length) : null
}

/** Suites a set of changed files (repo-relative) should run. */
export function selectSuites(manifest: Manifest, changedFiles: string[]): Suite[] {
  const changed = changedFiles.map(toWebRelative).filter((f): f is string => f !== null)
  if (changed.some((f) => matchesAny(f, manifest.runAll))) return manifest.suites
  return manifest.suites.filter((s) => changed.some((f) => matchesAny(f, s.paths)))
}

/** The scripts a suite names, with globs expanded against `allFiles` (apps/web-relative). Anything that matches nothing is reported as missing. */
export function expandScripts(suite: Suite, allFiles: string[]): { found: string[]; missing: string[] } {
  const found: string[] = []
  const missing: string[] = []
  for (const pattern of suite.scripts) {
    const hits = allFiles.filter((f) => !/\.test\.ts$/.test(f) && globToRegExp(pattern).test(f)).sort()
    if (hits.length === 0) missing.push(pattern)
    else found.push(...hits)
  }
  return { found, missing }
}

export type Outcome = 'pass' | 'regression' | 'error' | 'skipped' | 'not present'

/** 0 is a pass, 1 is a regression against the suite's thresholds, anything else is a broken script. */
export function outcomeForExit(code: number | null): Outcome {
  if (code === 0) return 'pass'
  if (code === 1) return 'regression'
  return 'error'
}

export function gateFails(outcomes: Outcome[]): boolean {
  return outcomes.some((o) => o === 'regression' || o === 'error')
}

export interface Row {
  suite: string
  script: string
  outcome: Outcome
  seconds?: number
}

/** Markdown for the job summary. */
export function summaryMarkdown(rows: Row[], note?: string): string {
  const lines = ['## Eval gate', '']
  if (note) lines.push(note, '')
  if (rows.length > 0) {
    lines.push('| Suite | Script | Result | Seconds |', '| --- | --- | --- | --- |')
    for (const r of rows) lines.push(`| ${r.suite} | \`${r.script}\` | ${r.outcome} | ${r.seconds ?? ''} |`)
  }
  return lines.join('\n')
}

// --- which scripts are eval entry points -------------------------------------

/** Folders under scripts/evals that hold helpers, data or saved copies, never entry points. */
const NOT_ENTRY_DIRS = new Set(['lib', 'data', 'rubrics', 'before', 'suites', 'prompts'])

function walk(dir: string, rel: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const r = `${rel}/${entry}`
    if (statSync(full).isDirectory()) {
      if (!NOT_ENTRY_DIRS.has(entry)) walk(full, r, out)
    } else if (/\.(ts|sh)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(r)
  }
}

/** Every script (apps/web-relative) that is an eval entry point: files under scripts/evals outside helper folders, and scripts/eval-*.ts. */
export function entryScripts(webRoot: string): string[] {
  const out: string[] = []
  walk(path.join(webRoot, 'scripts/evals'), 'scripts/evals', out)
  const scriptsDir = path.join(webRoot, 'scripts')
  if (existsSync(scriptsDir)) {
    for (const f of readdirSync(scriptsDir)) {
      if (/^eval-.*\.ts$/.test(f) && !/\.test\.ts$/.test(f)) out.push(`scripts/${f}`)
    }
  }
  // The gate itself runs the suites; it is not one.
  return out.filter((f) => f !== 'scripts/evals/run-gate.ts').sort()
}

/** Entry scripts that no suite in the manifest names. */
export function unlistedScripts(manifest: Manifest, entries: string[]): string[] {
  const patterns = manifest.suites.flatMap((s) => s.scripts)
  return entries.filter((e) => !matchesAny(e, patterns))
}

/** Every file under apps/web/scripts, relative to apps/web, for glob expansion. */
export function allScriptFiles(webRoot: string): string[] {
  const out: string[] = []
  const walkAll = (dir: string, rel: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walkAll(full, `${rel}/${entry}`)
      else out.push(`${rel}/${entry}`)
    }
  }
  walkAll(path.join(webRoot, 'scripts'), 'scripts')
  return out
}
