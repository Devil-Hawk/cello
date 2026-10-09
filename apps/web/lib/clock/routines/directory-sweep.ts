// directory.sweep: every 30 minutes, the directory's two jobs in one slice, inside the slice's own deadline.
//
//   1. Candidates first, for up to a minute: the seed's pending entries (and failed ones whose 90 days are over), in
//      this order: employers somebody follows, then YC rows, then the rest oldest first. Each is checked by the
//      verifier (companies.verify) and either joins the directory or keeps its reason.
//   2. Then verified boards by next_read_at, those with a posting in the last 30 days first: read with plain requests,
//      counted by role type and level, the roles inside somebody's targets stored, the rest left as numbers.
//
// A slice starts no new work after its deadline and hands nothing on: the next tick takes what is due. Full-cycle time
// is whatever the heartbeats say (T11), never a number this file promises.
//
// ponytail: CANDIDATES_PER_SLICE and BOARDS_PER_SLICE are the blueprint's [X]; the first measured slice day against the
// meter (spikes SP5 and SP6) sets them, and this file is where the committed numbers go.

import { mapWithConcurrency } from '../../ats/concurrency'
import type { DirectoryRow } from '../../companies/directory'
import { loadPeople, readEmployer, realReadDeps, type EmployerRead, type Person } from '../../companies/read-employer'
import { realDeps, settleCandidate, type CandidateRow, type VerifyDeps } from '../../companies/verify-directory'
import type { RoutineContext, RoutineOutcome } from '../routines'

export const CANDIDATES_PER_SLICE = 60
export const CANDIDATE_BUDGET_MS = 60_000
export const BOARDS_PER_SLICE = 100
const CONCURRENCY = 4

export interface SweepDeps {
  verify: VerifyDeps
  people: (db: RoutineContext['admin']) => Promise<Person[]>
  read: (db: RoutineContext['admin'], employer: DirectoryRow, people: Person[]) => Promise<EmployerRead>
}

export const realSweepDeps: SweepDeps = {
  verify: realDeps,
  people: loadPeople,
  read: (db, employer, people) => readEmployer(db, employer, people, realReadDeps(db)),
}

export async function sweepWith(ctx: RoutineContext, deps: SweepDeps): Promise<RoutineOutcome> {
  const found = { candidates: 0, verified: 0, failed: 0, retry: 0, boards: 0, read_failed: 0, listed: 0, kept: 0, stored: 0, errors: 0 }
  const candidateDeadline = Math.min(ctx.deadlineAt, ctx.now() + CANDIDATE_BUDGET_MS)

  const candidates = await ctx.admin.rpc('directory_candidates_due', { p_limit: CANDIDATES_PER_SLICE })
  if (candidates.error) return { ok: false, failure: 'candidates_due_failed' }
  await mapWithConcurrency((candidates.data ?? []) as CandidateRow[], CONCURRENCY, async (c) => {
    if (ctx.now() >= candidateDeadline) return
    found.candidates++
    try {
      found[(await settleCandidate(ctx.admin, c, deps.verify)).state]++
    } catch {
      found.errors++
    }
  })

  const boards = await ctx.admin.rpc('directory_boards_due', { p_limit: BOARDS_PER_SLICE })
  if (boards.error) return { ok: false, failure: 'boards_due_failed', found }
  const due = (boards.data ?? []) as DirectoryRow[]
  if (due.length > 0 && ctx.now() < ctx.deadlineAt) {
    const people = await deps.people(ctx.admin)
    await mapWithConcurrency(due, CONCURRENCY, async (employer) => {
      if (ctx.now() >= ctx.deadlineAt) return
      try {
        const r = await deps.read(ctx.admin, employer, people)
        found.boards++
        if (r.failure) found.read_failed++
        found.listed += r.listed
        found.kept += r.kept
        found.stored += r.stored
        found.errors += r.errors.length
      } catch {
        found.errors++
      }
    })
  }
  return { ok: true, found }
}

export const directorySweep = (ctx: RoutineContext): Promise<RoutineOutcome> => sweepWith(ctx, realSweepDeps)
