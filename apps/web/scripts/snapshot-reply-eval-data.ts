// Snapshot the labelled outreach reply dataset — judge groundedness score
// against the actual inbound reply classification — from the live database
// into a committed golden fixture. Same rationale and shape as
// snapshot-drafts-eval-data.ts; read that file's header first.
//
//   pnpm tsx scripts/snapshot-reply-eval-data.ts
//
// SOURCES
//   Ground truth — outreach_messages.replied_at + reply_classification
//   (design doc's "Ground truth wired: ... outreach reply columns written by
//   the Gmail bridge" — binding ruling 4, single writer lib/gmail/stage.ts).
//   replied_at IS NOT NULL means a reply actually arrived; reply_classification
//   is positive|neutral|negative|bounce (lib/outreach/types.ts). A message
//   with no reply yet has no ground truth and is excluded — same "unlabelled,
//   not a negative" reasoning every other snapshot script here applies.
//
//   Judge score — eval_verdicts where subject_kind='outreach_draft' and
//   judge='factuality' (the groundedness judge, written by both
//   app/api/outreach/draft/route.ts and app/api/outreach/judge/route.ts —
//   unlike cv_tailor_draft, both a pass AND a fail persist here, so there is
//   no equivalent coverage gap to document).
//
// WHY THE COMMITTED FIXTURE IS EXPECTED TO STAY BELOW THE FLOOR FOR A WHILE
//   outreach_messages.replied_at/reply_classification are BRAND NEW columns
//   (this same langgraph-port stage) with exactly one writer that only fires
//   on an actual inbound Gmail reply — there is no seed data and no way to
//   backfill history that was never captured. lib/evals/reply-label.eval.test.ts
//   reads whatever this script (or the tiny synthetic starter fixture
//   committed alongside it) produces and reports insufficient-data honestly
//   until real replies accumulate past MIN_SAMPLE_PER_CLASS. That refusal is
//   the intended state today, not a bug to work around.
//
// WHY DEMO ACCOUNTS ARE EXCLUDED HERE AND NOT IN THE EVAL
//   Same boundary-filter reasoning as every other snapshot script in this
//   directory — profiles.is_demo is the real demo flag; outreach_messages
//   carries no marker column of its own.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(process.cwd(), 'lib/evals/fixtures/reply-label.golden.json')

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

interface OutreachRow {
  id: string
  reply_classification: 'positive' | 'neutral' | 'negative' | 'bounce' | null
  profiles: { is_demo: boolean | null } | null
}
interface VerdictRow {
  subject_id: string
  score: number | null
}

async function main() {
  const messages = await rest<OutreachRow[]>(
    'outreach_messages?select=id,reply_classification,profiles(is_demo)&replied_at=not.is.null&limit=1000'
  )
  const genuine = messages.filter((m) => m.profiles?.is_demo !== true && m.reply_classification != null)

  const verdicts = await rest<VerdictRow[]>(
    'eval_verdicts?select=subject_id,score&subject_kind=eq.outreach_draft&judge=eq.factuality&limit=1000'
  )
  const verdictByMessage = new Map(verdicts.map((v) => [v.subject_id, v]))

  const cases = genuine
    .map((m) => ({ m, verdict: verdictByMessage.get(m.id) }))
    // Refuse-over-guess: no judge verdict recorded, no case.
    .filter((c): c is { m: OutreachRow; verdict: VerdictRow } => c.verdict != null && c.verdict.score != null)
    .map(({ m, verdict }) => ({
      id: m.id,
      judgeScore: verdict.score as number,
      replyClassification: m.reply_classification as 'positive' | 'neutral' | 'negative' | 'bounce',
    }))

  const fixture = {
    note:
      'Labelled outreach reply data snapshotted from production: judge groundedness score ' +
      '(eval_verdicts, subject_kind=outreach_draft, judge=factuality) against the actual reply ' +
      'classification (outreach_messages.replied_at + reply_classification). Demo accounts ' +
      "excluded at snapshot time. Regenerate: pnpm tsx scripts/snapshot-reply-eval-data.ts",
    cases,
  }

  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')

  console.log(`wrote ${OUT}`)
  console.log(`  replied outreach messages (demo excluded): ${genuine.length}`)
  console.log(`  labelled cases (judge score present): ${cases.length}`)
  if (cases.length < 20) {
    console.log(
      `\n  NOTE: ${cases.length} labelled case(s). The reply-label eval refuses below ` +
        `MIN_SAMPLE_PER_CLASS (10) of each class — expected today, see this script's own header.`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
