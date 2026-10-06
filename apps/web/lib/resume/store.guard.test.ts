// Resumes are made things (K17): the base resume and each tailored resume are `artifacts`
// with numbered versions, and lib/resume/store.ts is the one writer. `resume_documents` is
// read-only history, so nothing in the app may write it. This scans the source so a new writer
// fails here instead of in production.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function sources(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = []
  for (const dir of ['app', 'lib', 'scripts']) {
    let files: string[] = []
    try {
      files = walk(path.join(ROOT, dir))
    } catch {
      continue
    }
    for (const file of files) out.push({ rel: path.relative(ROOT, file).split(path.sep).join('/'), src: readFileSync(file, 'utf8') })
  }
  return out
}

describe('resume writers', () => {
  it('nothing writes resume_documents: it is read-only history', () => {
    const offenders = sources()
      // The owned-tables and provenance lists name the table; they write nothing.
      .filter(({ rel }) => !rel.startsWith('lib/provenance/tables/') && !rel.startsWith('lib/commands/owned/'))
      .filter(({ src }) => /resume_documents['"`]\s*\)\s*\.(insert|upsert|update|delete)\(/.test(src) || /table:\s*['"]resume_documents['"]/.test(src))
      .map(({ rel }) => rel)
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
