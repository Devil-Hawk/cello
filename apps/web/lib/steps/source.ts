// The scanner behind the steps source test (directive 20): which files make a raw
// model call. A call is raw when it reaches a model without going through a
// declared step. The only places that may are the model doors themselves
// (callLlm, the providers, the factory) and the steps that wrap them.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AllowEntry } from './allow/types'

/** Flipped by the last step of the build, once every lane has emptied its
 *  allowlist. While false, an allowlist entry is tolerated if its file still makes
 *  the call; when true, any entry at all fails. */
export const STRICT = false

export const RAW_CALL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'callLlm(', re: /\bcallLlm\(/ },
  { name: 'callEmbedding(', re: /\bcallEmbedding\(/ },
  { name: 'new ChatOpenRouter|ChatOpenAI|ChatAnthropic|ChatWebLLM(', re: /\bnew Chat(?:OpenRouter|OpenAI|Anthropic|WebLLM)\(/ },
  { name: 'new OpenAI( or new Anthropic(', re: /\bnew (?:OpenAI|Anthropic)\(/ },
  { name: "import of 'openai' or '@anthropic-ai/sdk'", re: /\bfrom\s+['"](?:openai|@anthropic-ai\/sdk)['"]/ },
  { name: '.messages.create(', re: /\.messages\.create\(/ },
  { name: '.chat.completions.create(', re: /\.chat\.completions\.create\(/ },
  { name: 'import of callLlm or callEmbedding', re: /import\s*\{[^}]*\b(?:callLlm|callEmbedding)\b[^}]*\}\s*from/ },
]

/** The model doors and the steps: they are the code the rule is about. */
const EXEMPT = ['lib/harness/llm.ts', 'lib/harness/providers/', 'lib/steps/', 'lib/models/']

export const isExempt = (rel: string) => EXEMPT.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e))

const SKIP_DIRS = new Set(['node_modules', '.next', '.next-verify', '.next-3311', 'public', '.turbo', 'dist'])

export function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/gm, '$1')
}

export function rawCallsIn(text: string): string[] {
  const code = stripComments(text)
  return RAW_CALL_PATTERNS.filter((p) => p.re.test(code)).map((p) => p.name)
}

export interface SourceFile {
  rel: string
  text: string
}

/** Every non-test .ts and .tsx file under `root`, with paths relative to it. */
export function sourceFiles(root: string, dir: string = root, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(root, full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push({ rel: path.relative(root, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') })
    }
  }
  return out
}

/** Files that make a raw call and are not exempt. */
export function rawCallers(files: SourceFile[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const f of files) {
    if (isExempt(f.rel)) continue
    const hits = rawCallsIn(f.text)
    if (hits.length > 0) out.set(f.rel, hits)
  }
  return out
}

/** What is wrong with the allowlist given the raw callers found: a raw call with
 *  no entry, an entry whose file no longer makes one (stale), a duplicate entry,
 *  and in strict mode any entry at all. */
export function allowlistProblems(callers: Map<string, string[]>, allowlist: readonly AllowEntry[], strict: boolean): string[] {
  const problems: string[] = []
  const listed = new Set<string>()
  for (const entry of allowlist) {
    if (listed.has(entry.file)) problems.push(`${entry.file} is listed twice`)
    listed.add(entry.file)
    if (!entry.reason.trim()) problems.push(`${entry.file} is listed with no reason`)
    if (!callers.has(entry.file)) problems.push(`${entry.file} is on an allowlist but makes no raw model call: delete the entry`)
    else if (strict && !entry.permanent) problems.push(`${entry.file} is still allowlisted and the rule is strict`)
  }
  for (const [file, hits] of callers) {
    if (!listed.has(file)) problems.push(`${file} makes a raw model call (${hits.join(', ')}) and is not behind a step or on an allowlist`)
  }
  return problems
}
