// No read of `jobs` outside person_roles. A role is shared by everyone it fits, so reading it by company
// or by id alone shows a person a role they do not hold, or hides one they do. Every read goes through
// the person_jobs view; the only files excused are in person-roles-scan.allow.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { K8A_READERS, STORE_READERS } from './person-roles-scan.allow'

/** Vitest runs with cwd = apps/web. */
const WEB = process.cwd()
const ROOTS = ['app', 'components', 'lib', 'scripts']
const excused = [...K8A_READERS, ...STORE_READERS]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** Comments out, so a sentence that quotes `.from('jobs').select(` is not a read. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const reads = (text: string) => strip(text).match(/\.from\(\s*['"`]jobs['"`]\s*\)\s*\.select\(/g)?.length ?? 0

describe('person roles scan', () => {
  it('sees a read over lines, and not a write, a comment or another table', () => {
    expect(reads("await admin\n  .from('jobs')\n  // open ones\n  .select('id')")).toBe(1)
    expect(reads("await admin.from('jobs').update({ is_new: false })")).toBe(0)
    expect(reads("// db.from('jobs').select('id')\nconst a = 1")).toBe(0)
    expect(reads("await db.from('jobs_archive').select('id')")).toBe(0)
  })

  it('finds no read of jobs outside the excused files, and no excused file that stopped reading', () => {
    const found: string[] = []
    const stale: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(path.join(WEB, root))) {
        const rel = path.relative(WEB, file).split(path.sep).join('/')
        const n = reads(readFileSync(file, 'utf8'))
        if (n > 0 && !excused.includes(rel)) found.push(`${rel} (${n})`)
      }
    }
    for (const rel of excused) if (reads(readFileSync(path.join(WEB, rel), 'utf8')) === 0) stale.push(rel)
    expect(found, "read through .from('person_jobs')").toEqual([])
    expect(stale, 'no longer reads jobs: remove it from person-roles-scan.allow.ts').toEqual([])
  })

  it('has no companies( embed in a select on person_jobs: it follows jobs.company_id, the first storer\'s company', () => {
    const embed = (text: string) => /(?:\.from\(\s*['"`]person_jobs['"`]\s*\)|personJobs\([^)]*\))\s*\.select\(\s*['"`][^'"`]*companies\(/.test(strip(text))
    expect(embed("db.from('person_jobs').select('id, companies(metadata)')")).toBe(true)
    expect(embed("personJobs(db).select('id, companies(name)')")).toBe(true)
    expect(embed("db.from('person_jobs').select('id, viewer_company_metadata')")).toBe(false)
    const found: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(path.join(WEB, root))) {
        if (embed(readFileSync(file, 'utf8'))) found.push(path.relative(WEB, file).split(path.sep).join('/'))
      }
    }
    expect(found, 'read viewer_company_name or viewer_company_metadata from the view').toEqual([])
  })

  it('has no inner join to companies: a role the sweep stored has company_id null, and the join drops it', () => {
    const found: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(path.join(WEB, root))) {
        if (/companies!inner/.test(strip(readFileSync(file, 'utf8')))) found.push(path.relative(WEB, file).split(path.sep).join('/'))
      }
    }
    expect(found, 'read the name from viewer_company_name, or company_directory through jobs.employer_id').toEqual([])
  })
})
