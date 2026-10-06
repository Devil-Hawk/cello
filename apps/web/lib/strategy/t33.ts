// T33, What is working, on fixture events: each finding's counts equal the hand counts; an unconfirmed event moves
// no count; nothing is stated below its threshold; and the same fixture run twice gives the same findings.
// (A Keep that changes anything it does not name is checked in lib/commands/defs/results.test.ts, on a spy of the
// stores.) apps/web/scripts/network-measures.ts `fixtures` records the result in measure_runs.

import { onlyTrusted, type TrustedActivity } from '@/lib/learning/learner'
import { EMPTY_TARGETING } from '@/lib/targeting'
import { runStrategyAnalysis } from './index'
import type { ActivityRow, ApplicationRow, StrategyDataSource } from './datasource'
import { findingsFrom } from './findings'
import { shapeFindings } from './shape'

const NOW = new Date('2026-10-06T12:00:00Z')
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const app = (i: number, source: string, over: Partial<ApplicationRow> = {}): ApplicationRow => ({
  id: `a${i}`, jobId: `j${i}`, stage: 'applied', appliedAt: day(30), createdAt: day(30), applicationSource: null, companyId: `c${i}`, companyName: `Company ${i}`,
  jobSource: source, jobPostedAt: day(33), chance: null, jobFunction: null, seniority: null, closedReason: null, ...over,
})

/** 9 applications from Referral (5 answered) and 12 from Job board (1 answered), by hand. */
const apps: ApplicationRow[] = [...Array.from({ length: 9 }, (_, i) => app(i, 'Referral')), ...Array.from({ length: 12 }, (_, i) => app(9 + i, 'Job board'))]
const answered = [0, 1, 2, 3, 4, 9]
const events: TrustedActivity[] = [
  ...answered.map((i) => ({ id: `e${i}`, applicationId: `a${i}`, type: 'email_received', occurredAt: day(26), trust: 'proven' })),
  // forged mail on three applications that never answered: never counted
  ...[5, 6, 10].map((i) => ({ id: `u${i}`, applicationId: `a${i}`, type: 'email_received', occurredAt: day(20), trust: 'unconfirmed' })),
]

const source = (activities: TrustedActivity[]): StrategyDataSource => ({
  getApplications: async () => apps,
  getActivities: async () => onlyTrusted(activities) as ActivityRow[],
  getResumeDocuments: async () => [],
  getOutreachMessages: async () => [],
  getJobScopeCounts: async () => ({ totalJobs: 0, totalPassingAllConfiguredFilters: 0, jobsWithNoDescription: 0, excludedByDimension: {}, excludedByKeywords: null }),
})

/** A proposal's id is a per-report counter, so findings are compared by what they count. */
const counted = (f: ReturnType<typeof findingsFrom>) => JSON.stringify([...f.working, ...f.notWorking].map((x) => [x.key, x.line, x.applications, x.replies]))

export interface T33Case {
  name: string
  pass: boolean
}

export async function t33Cases(): Promise<T33Case[]> {
  const read = async (activities: TrustedActivity[]) => {
    const ds = source(activities)
    const report = await runStrategyAnalysis(ds, 'fixture', EMPTY_TARGETING)
    return { report, found: findingsFrom(report, shapeFindings(apps, await ds.getActivities([]), [], NOW)) }
  }
  const { report, found } = await read(events)
  const lines = [...found.working, ...found.notWorking].map((f) => f.line)
  return [
    { name: 'the Referral finding equals the hand count, 5 of 9', pass: lines.includes('5 of 9 applications from Referral got a reply.') },
    { name: 'the Job board finding equals the hand count, 1 of 12', pass: lines.includes('1 of 12 applications from Job board got a reply.') },
    { name: 'unconfirmed events are counted 0 times', pass: found.working.concat(found.notWorking).filter((f) => f.dimension === 'source').reduce((s, f) => s + f.replies, 0) === 6 },
    { name: 'a question below its threshold states no finding, only its sentence', pass: report.resumeVariants.status === 'insufficient_data' && !lines.some((l) => /resume/i.test(l)) && found.thresholds.length > 0 },
    { name: 'the same events give the same findings', pass: counted((await read(events)).found) === counted(found) },
  ]
}
