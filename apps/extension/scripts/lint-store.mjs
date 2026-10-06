// Lints the store package and the install guide for words Cello never uses.
// `node scripts/lint-store.mjs` exits 1 on any finding.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RULES = [
  [/receipt/i, 'the word receipt'],
  [/\u2014/, 'an em dash'],
  [/!/, 'an exclamation mark'],
  [/\p{Extended_Pictographic}/u, 'an emoji'],
]

/** Findings for one text, each "name:line: what". */
export function lintText(text, name = 'text') {
  const out = []
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of RULES) if (re.test(line)) out.push(`${name}:${i + 1}: ${what}`)
    const m = /^Short description:\s*(.*)$/.exec(line)
    if (m && m[1].length > 132) out.push(`${name}:${i + 1}: short description is ${m[1].length} characters, the limit is 132`)
  })
  return out
}

export function lintFiles(files) {
  return files.flatMap((f) => lintText(readFileSync(f, 'utf8'), f))
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const store = join(root, 'store')
  const files = readdirSync(store)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(store, f))
  files.push(join(root, '..', '..', 'docs', 'extension-install.md'))
  const problems = lintFiles(files)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`store lint: ${files.length} files clean`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
