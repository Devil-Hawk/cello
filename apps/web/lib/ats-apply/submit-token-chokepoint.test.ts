// Guards ruling 8's "the human click is the only writer of submit-phase
// tokens": app/api/apply/confirm/route.ts must be the ONLY place in this
// codebase that calls issuePhaseToken with phase: 'submit'. No graph node,
// no autopilot code, no other API route may mint one — there is no second
// door onto a real submission for assisted apply, matching the same
// single-call-site discipline binding ruling 7 gives invokeGraphForUser.
//
// Source-level scan, same idiom as lib/harness/spend-chokepoints.test.ts and
// lib/a2a/graph-shape.test.ts: it proves the SOURCE TEXT has the shape it
// claims, across every file that could plausibly reach this call.
//
// MUTATION CHECK (executed, not left to trust): added a scratch call
// `issuePhaseToken(admin, { draftId, userId, phase: 'submit' })` inside
// lib/graph/autopilot.ts, re-ran this file — 'is minted nowhere but
// app/api/apply/confirm/route.ts' went red, naming autopilot.ts as a second
// offender. Reverted immediately.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOTS = [
  path.resolve(process.cwd(), 'app/api'),
  path.resolve(process.cwd(), 'lib/graph'),
  path.resolve(process.cwd(), 'lib/harness'),
  path.resolve(process.cwd(), 'lib/mcp'),
  path.resolve(process.cwd(), 'lib/a2a'),
]

const CONFIRM_ROUTE = path.resolve(process.cwd(), 'app/api/apply/confirm/route.ts')

// Matches how confirm/route.ts actually calls it — a source-shape check, not
// a parser, same as this repo's other chokepoint tests.
const SUBMIT_MINT_RE = /issuePhaseToken\([^)]*phase:\s*'submit'/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('submit-phase token mint chokepoint', () => {
  it('app/api/apply/confirm/route.ts really does mint a submit-phase token — proves the pattern is not vacuous', () => {
    const source = readFileSync(CONFIRM_ROUTE, 'utf8')
    expect(SUBMIT_MINT_RE.test(source)).toBe(true)
  })

  it('is minted nowhere but app/api/apply/confirm/route.ts', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (file === CONFIRM_ROUTE) continue
        const source = readFileSync(file, 'utf8')
        if (SUBMIT_MINT_RE.test(source)) offenders.push(file)
      }
    }
    expect(offenders, `phase: 'submit' must be minted ONLY by app/api/apply/confirm/route.ts, found in: ${offenders.join(', ')}`).toEqual([])
  })

  it('issuePhaseToken itself is exported from exactly one module', () => {
    // Guards the premise: if issuePhaseToken ever gets re-exported from a
    // second module, a caller could import THAT path and dodge the scan
    // above entirely.
    const source = readFileSync(
      path.resolve(process.cwd(), 'lib/ats-apply/phase-tokens.ts'),
      'utf8'
    )
    expect(source).toContain('export async function issuePhaseToken')
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (file.endsWith('lib/ats-apply/phase-tokens.ts')) continue
        const source2 = readFileSync(file, 'utf8')
        expect(source2, `${file} must not re-export issuePhaseToken by name`).not.toMatch(
          /export\s*\{[^}]*issuePhaseToken/
        )
      }
    }
  })
})
