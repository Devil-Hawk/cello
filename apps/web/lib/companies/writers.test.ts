// A source scan: who may write the shared directory, and who may write a person's companies from the add path.
//
//   company_directory   only companies.verify (verify-directory.ts) writes it. The one other door is the live read's
//                       "of N open" number (live-roles.ts, set_employer_open_count), named below, never a row.
//   companies           the directory's own files (search, add, sweep, seed, the add route) never write it; the add
//                       path reaches it only through follow.ts, which calls the existing save (add.ts).
//
// It reads every source file of the app, so a new writer anywhere fails here, not in review.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const WEB = process.cwd()

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const rel = (file: string) => path.relative(WEB, file).split(path.sep).join('/')
const files = ['app', 'lib', 'scripts', 'components'].flatMap((d) => walk(path.join(WEB, d)))

const writes = (table: string) => new RegExp(`from\\(\\s*['"\`]${table}['"\`]\\s*\\)\\s*\\.(insert|update|upsert|delete)\\(`)
/** SQL functions that change company_directory. */
const DIRECTORY_RPCS = /\.rpc\(\s*['"`]set_employer_open_count['"`]/

const offenders = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel)

describe('the scanner itself', () => {
  it('sees a write, in any of the four forms, and ignores a read', () => {
    const re = writes('company_directory')
    for (const op of ['insert', 'update', 'upsert', 'delete']) expect(re.test(`await db.from('company_directory').${op}({})`)).toBe(true)
    expect(re.test("await db.from('company_directory').select('*')")).toBe(false)
    expect(re.test('await db.from(\n  "company_directory"\n).update({})')).toBe(true)
  })
})

describe('who writes company_directory', () => {
  it('only companies.verify (verify-directory.ts)', () => {
    expect(offenders(writes('company_directory'))).toEqual(['lib/companies/verify-directory.ts'])
  })

  it('and no function writes it except the live read open-count number', () => {
    expect(offenders(DIRECTORY_RPCS)).toEqual(['lib/companies/live-roles.ts'])
  })
})

describe('who writes a person companies row from the directory', () => {
  const DIRECTORY_FILES = [
    'lib/companies/add-link.ts',
    'lib/companies/directory.ts',
    'lib/companies/read-employer.ts',
    'lib/companies/verify-directory.ts',
    'lib/clock/routines/directory-seed.ts',
    'lib/clock/routines/directory-sweep.ts',
    'app/api/companies/add/route.ts',
    'app/api/companies/route.ts',
  ]

  it('the directory, search, add, sweep and seed files never write companies', () => {
    const bad = DIRECTORY_FILES.filter((f) => writes('companies').test(readFileSync(path.join(WEB, f), 'utf8')))
    expect(bad).toEqual([])
  })

  it('the add path follows only through follow.ts, which saves through the existing add.ts', () => {
    const add = readFileSync(path.join(WEB, 'lib/companies/add-link.ts'), 'utf8')
    expect(add).toMatch(/from '\.\/follow'/)
    const follow = readFileSync(path.join(WEB, 'lib/companies/follow.ts'), 'utf8')
    expect(follow).toMatch(/saveCompany\(/)
  })

  it('the files exist: a renamed file cannot leave the scan checking nothing', () => {
    for (const f of DIRECTORY_FILES) expect(() => statSync(path.join(WEB, f))).not.toThrow()
  })
})
