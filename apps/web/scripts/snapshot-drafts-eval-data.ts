// Snapshot the labelled cv_tailor draft dataset — judge score, containment
// report, and the human accept/reject decision — from the live database into
// a committed golden fixture. Same rationale as snapshot-eval-data.ts: CI has
// no database and needs determinism, so the labelled set is committed and the
// eval (lib/evals/drafts-label.eval.test.ts) reads that, never a live query.
//
//   pnpm tsx scripts/snapshot-drafts-eval-data.ts
//
// SOURCES
//   Human decision — application_drafts.status + reviewed_at (design doc's
//   "Ground truth wired: application_drafts.status + reviewed_at"). reviewed_
//   at IS NOT NULL means a human actually acted; status in (approved,
//   submitted) is accept, (rejected, failed) is reject. pending_review rows
//   have no decision YET and are excluded — undecided, not a negative, same
//   as match-scorer's own "never applied" rows are unlabelled, not a
//   negative-with-a-reason.
//
//   Judge score — eval_verdicts where subject_kind='cv_tailor_draft' and
//   judge='factuality' (cv-tailor.ts's own groundedness judge, written by
//   lib/graph/autopilot.ts).
//
//   Containment report — trace_spans, journal.ts's step ledger: kind='node',
//   attributes.stepStatus='completed', attributes.agentType in ('cv_tailor',
//   'resume_optimizer'), matched to a draft via application_drafts.run_id.
//   attributes.containment is the same object lib/graph/unit.ts attaches to
//   every containment-checked unit's journaled output.
//
// KNOWN GAP, DOCUMENTED RATHER THAN WORKED AROUND
//   lib/graph/autopilot.ts only calls writeVerdict(subjectKind:
//   'cv_tailor_draft') on a judge FAILURE or an unjudged call today — never
//   on a passing judgeGroundedness() result (see that file's `flaggedVerdict`
//   local, only ever set on the 'fail'/'unjudged' branches of
//   cv-tailor.ts's verify outcome). That means this snapshot's judge-score
//   coverage is a strict subset of reviewed drafts: any accepted draft whose
//   judge call passed cleanly has no eval_verdicts row at all and is
//   correctly excluded below (a missing verdict is refuse-over-guess, never
//   scored as 0). Closing that gap is a separate change to autopilot.ts, out
//   of scope here — this script snapshots what's actually persisted today
//   and says so in the fixture's own note.
//
// WHY DEMO ACCOUNTS ARE EXCLUDED HERE AND NOT IN THE EVAL
//   Same "filter at the snapshot boundary" reasoning as snapshot-eval-data.ts's
//   DEMO_MARKER filter: a seeded demo account's drafts would contaminate a
//   labelled set an eval reader trusts as real behaviour. profiles.is_demo is
//   this app's actual demo flag (lib/access/guardrails.ts) — application_
//   drafts carries no notes column to stash a marker string in, so the
//   filter joins profiles instead.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(process.cwd(), 'lib/evals/fixtures/drafts-label.golden.json')
const DECIDED_STATUSES = ['approved', 'submitted', 'rejected', 'failed']

function env(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`${key} is required`)
  return v
}

const BASE = env('SUPABASE_URL')
const KEY = env('SUPABASE_SERVICE_KEY')

async function rest<T>(query: string): Promise<T> {
  const res = await fetch(`${BASE}/rest/v1/${query}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`${query} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

interface DraftRow {
  id: string
  run_id: string | null
  status: string
  reviewed_at: string | null
  profiles: { is_demo: boolean | null } | null
}
interface VerdictRow {
  subject_id: string
  score: number | null
  verdict: string
}
interface SpanRow {
  run_id: string | null
  attributes: { agentType?: string; containment?: { ok: boolean; reason: string | null } } | null
}

async function main() {
  const drafts = await rest<DraftRow[]>(
    `application_drafts?select=id,run_id,status,reviewed_at,profiles(is_demo)&reviewed_at=not.is.null&status=in.(${DECIDED_STATUSES.join(',')})&limit=1000`
  )
  const genuine = drafts.filter((d) => d.profiles?.is_demo !== true)

  const verdicts = await rest<VerdictRow[]>(
    'eval_verdicts?select=subject_id,score,verdict&subject_kind=eq.cv_tailor_draft&judge=eq.factuality&limit=1000'
  )
  const verdictByDraft = new Map(verdicts.map((v) => [v.subject_id, v]))

  const spans = await rest<SpanRow[]>(
    "trace_spans?select=run_id,attributes&kind=eq.node&attributes->>agentType=in.(cv_tailor,resume_optimizer)&limit=2000"
  )
  const containmentByRun = new Map(
    spans.filter((s) => s.run_id && s.attributes?.containment).map((s) => [s.run_id as string, s.attributes!.containment!])
  )

  const cases = genuine
    .map((d) => {
      const verdict = verdictByDraft.get(d.id)
      const containment = d.run_id ? containmentByRun.get(d.run_id) : undefined
      return { d, verdict, containment }
    })
    // Refuse-over-guess: no judge verdict recorded, no case — never scored as 0.
    .filter((c): c is { d: DraftRow; verdict: VerdictRow; containment: { ok: boolean; reason: string | null } | undefined } =>
      c.verdict != null && c.verdict.score != null
    )
    .map(({ d, verdict, containment }) => ({
      id: d.id,
      judgeScore: verdict.score as number,
      judgeVerdict: verdict.verdict,
      containmentOk: containment?.ok ?? true,
      containmentReason: containment?.reason ?? null,
      status: d.status,
      humanAccepted: d.status === 'approved' || d.status === 'submitted',
    }))

  const fixture = {
    note:
      'Labelled cv_tailor draft data snapshotted from production: judge score (eval_verdicts, ' +
      'subject_kind=cv_tailor_draft, judge=factuality) against the human accept/reject decision ' +
      '(application_drafts.status + reviewed_at) and the containment report (trace_spans). Demo ' +
      'accounts excluded at snapshot time. KNOWN GAP: autopilot.ts only persists a cv_tailor_draft ' +
      "verdict on fail/unjudged today, never on a pass — see this script's own header. " +
      'Regenerate: pnpm tsx scripts/snapshot-drafts-eval-data.ts',
    cases,
  }

  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')

  console.log(`wrote ${OUT}`)
  console.log(`  reviewed drafts (demo excluded): ${genuine.length}`)
  console.log(`  labelled cases (judge score present): ${cases.length}`)
  if (cases.length < 20) {
    console.log(
      `\n  NOTE: ${cases.length} labelled case(s). The ranking/precision evals refuse below ` +
        `MIN_SAMPLE_PER_CLASS (10) of each class — see this script's KNOWN GAP note for why real ` +
        `coverage is thin today.`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
