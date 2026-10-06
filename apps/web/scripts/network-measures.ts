// Network measures T30, T31 and T32 (K26). Run from apps/web with service-role credentials:
//
//   npx tsx scripts/network-measures.ts sheet <owner user id> > marks.csv    100 kept people and up to 50 left out, to mark
//   npx tsx scripts/network-measures.ts score marks.csv                       writes the T30 and T31 runs
//   npx tsx scripts/network-measures.ts fixtures                              writes the T32 run on the scripted threads
//
// Mark the CSV yourself: `real` is yes when you have been in touch with that person about your search; `tie_right`
// is yes or no for the employer shown, or blank when none is shown. S18, S25 and S26 are marked the same way and
// recorded by the scorecard command.

import { readFileSync } from 'node:fs'
import { createAdminClient } from '../lib/harness/supabase-admin'
import { scoreT30, scoreT31, scoreT32, T32_CASES, type Mark, type Score } from '../lib/network/measures'

async function record(id: 'T30' | 'T31' | 'T32', s: Score): Promise<void> {
  const { error } = await createAdminClient().from('measure_runs').insert({ measure_id: id, value: s.value, passed: s.passed, sample_n: s.sample_n, note: s.note })
  if (error) throw new Error(`could not record ${id}`)
  console.log(`${id}: ${s.value === null ? 'no value' : s.value} (${s.passed ? 'passed' : 'not passed'}) ${s.note}`)
}

const yes = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'yes'

function parseMarks(csv: string): Mark[] {
  return csv
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const [email, kept, real, tieRight, relay] = l.split(',').map((c) => c.trim())
      return { email, kept: yes(kept), real: yes(real), tieRight: tieRight ? yes(tieRight) : null, tieFromRelayOrPersonal: yes(relay) }
    })
}

async function sheet(owner: string): Promise<void> {
  const admin = createAdminClient()
  const { data: kept } = await admin.from('contacts').select('email, employer_id, employer_origin, address_kind').eq('user_id', owner).eq('source', 'gmail').not('email', 'is', null).order('first_seen_at', { ascending: false }).limit(100)
  const { data: beat } = await admin.from('job_heartbeats').select('found').eq('job', 'network.sync').eq('user_id', owner).maybeSingle()
  const left = ((beat as { found?: { leftOut?: { addresses?: { email: string }[] } } } | null)?.found?.leftOut?.addresses ?? []).slice(-50)
  console.log('email,kept,real,tie_right,tie_from_relay_or_personal')
  for (const c of (kept ?? []) as { email: string; employer_id: string | null; address_kind: string | null }[]) console.log(`${c.email},yes,,${c.employer_id ? '' : 'none'},${c.address_kind === 'personal' && c.employer_id ? 'check' : 'no'}`)
  for (const l of left) console.log(`${l.email},no,,,no`)
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'sheet' && arg) return sheet(arg)
  if (cmd === 'score' && arg) {
    const marks = parseMarks(readFileSync(arg, 'utf8'))
    await record('T30', scoreT30(marks))
    await record('T31', scoreT31(marks))
    return
  }
  if (cmd === 'fixtures') return record('T32', scoreT32(T32_CASES))
  console.error('usage: network-measures.ts sheet <owner id> | score <marks.csv> | fixtures')
  process.exit(1)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
