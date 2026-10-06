// resume_documents has exactly one writer: lib/resume/store.ts. A second path
// that inserts a row can store a version whose plain text, Markdown and
// structure disagree, or skip the structure entirely, which is how a resume
// ended up with "no format". This scans the source so a new writer fails here
// instead of in production.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const ALLOWED = new Set(['lib/resume/store.ts', 'lib/access/seed-demo.ts'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

describe('resume_documents writers', () => {
  it('only store.ts and the demo seeder write rows', () => {
    const offenders: string[] = []
    for (const dir of ['app', 'lib', 'scripts']) {
      let files: string[] = []
      try {
        files = walk(path.join(ROOT, dir))
      } catch {
        continue
      }
      for (const file of files) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        if (ALLOWED.has(rel)) continue
        const src = readFileSync(file, 'utf8')
        if (/resume_documents['"`]\s*\)\s*\.(insert|upsert|update)\(/.test(src)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the demo seeder builds its rows with deriveResumeColumns', () => {
    expect(readFileSync(path.join(ROOT, 'lib/access/seed-demo.ts'), 'utf8')).toContain('deriveResumeColumns(')
  })

  it('the raw row insert is not exported', async () => {
    const store = (await import('./store')) as Record<string, unknown>
    expect(store.createVersion).toBeUndefined()
    expect(store.insertVersionRow).toBeUndefined()
    expect(store.createMarkdownVersion).toBeUndefined()
  })
})
