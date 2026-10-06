// Replay a mailbox through the code that decides what mail means and how far to believe it. No
// network, no model: sender, DKIM, status patterns and contact kind, mail by mail, against what each
// mail must conclude.
//
//   npx tsx lib/gmail/replay.ts             the fixture in __fixtures__/mailbox (a fixture, not S8)
//   npx tsx lib/gmail/replay.ts <file.json> a mailbox of the same shape, once the owner grants theirs
//   add --record to write the measure_runs rows (S8, S9) with the service role, on the owner's file only
//
// S8 (mail: precision of what code calls proven, recall of the mails that should be): of the mails
// code calls proven, how many are right; of the mails that are proven, how many it finds.
// S9 (employer from email accepted wrongly): a mail that is not from the verified employer but is
// proven for it. Must be 0.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { contactKind } from '../contacts/kind'
import { classifyWithPatterns } from './classify'
import { kindOfStatus } from './messages'
import { headerVerdict, senderEmployerDomain, trustOf } from './trust'

export interface ReplayMail {
  id: string
  label: string
  from: string
  subject: string
  body: string
  headers: { name: string; value: string }[]
  employer: string | null
  expect: { trust: string; status: string; kind: string; contact?: string; employerFromSender?: null; personal?: boolean }
}

export interface Replay {
  mails: number
  provenCalled: number
  provenRight: number
  provenTruth: number
  precision: number | null
  recall: number | null
  wrongEmployers: number
  mismatches: string[]
}

const domainOf = (from: string): string | null => /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(from)?.[1]?.toLowerCase() ?? null

export function replay(mails: readonly ReplayMail[]): Replay {
  const out: Replay = { mails: mails.length, provenCalled: 0, provenRight: 0, provenTruth: 0, precision: null, recall: null, wrongEmployers: 0, mismatches: [] }
  for (const m of mails) {
    const fromDomain = domainOf(m.from)
    const verdict = headerVerdict(m.headers, fromDomain)
    const trust = trustOf({ fromDomain, employerDomain: m.employer, verdict })
    const parsed = classifyWithPatterns(m.from, m.subject, m.body, new Date('2026-10-01T12:00:00Z'))
    const display = m.from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || null
    const ck = contactKind({ displayName: display, address: /<([^>]+)>/.exec(m.from)?.[1] ?? m.from, subject: m.subject, body: m.body })
    const kind = kindOfStatus(parsed.status, ck.kind === 'recruiter' || ck.kind === 'agency_recruiter')

    const got = { trust, status: parsed.status, kind, ...(m.expect.contact ? { contact: ck.kind } : {}) }
    const want = { trust: m.expect.trust, status: m.expect.status, kind: m.expect.kind, ...(m.expect.contact ? { contact: m.expect.contact } : {}) }
    if (JSON.stringify(got) !== JSON.stringify(want)) out.mismatches.push(`${m.id} ${m.label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
    if ('employerFromSender' in m.expect && senderEmployerDomain(fromDomain) !== null) out.mismatches.push(`${m.id} ${m.label}: a relay was taken for the employer`)

    if (trust === 'proven') out.provenCalled++
    if (trust === 'proven' && m.expect.trust === 'proven') out.provenRight++
    if (m.expect.trust === 'proven') out.provenTruth++
    // proven for an employer the sender is not: the sender is neither the employer nor a relay
    if (trust === 'proven' && fromDomain && !(m.employer && (fromDomain === m.employer || fromDomain.endsWith(`.${m.employer}`))) && senderEmployerDomain(fromDomain) !== null) out.wrongEmployers++
  }
  out.precision = out.provenCalled ? out.provenRight / out.provenCalled : null
  out.recall = out.provenTruth ? out.provenRight / out.provenTruth : null
  return out
}

export function loadMailbox(file?: string): ReplayMail[] {
  const p = file ?? path.join(path.dirname(new URL(import.meta.url).pathname), '__fixtures__/mailbox/mails.json')
  return (JSON.parse(readFileSync(p, 'utf8')) as { mails: ReplayMail[] }).mails
}

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const r = replay(loadMailbox(file))
  console.log(JSON.stringify({ ...r, mismatches: undefined }, null, 2))
  for (const m of r.mismatches) console.log(' -', m)
  if (process.argv.includes('--record')) {
    if (!file) throw new Error('--record writes S8 and S9, which are the owner\'s mailbox: pass its file. The fixture is not S8.')
    const { createAdminClient } = await import('../harness/supabase-admin')
    const db = createAdminClient()
    const rows = [
      { measure_id: 'S8', value: r.precision, passed: r.precision !== null && r.recall !== null ? r.precision >= 0.95 && r.recall >= 0.9 : null, sample_n: r.mails, note: `precision ${r.precision?.toFixed(3)}, recall ${r.recall?.toFixed(3)} of mails code calls proven, on ${file}.` },
      { measure_id: 'S9', value: r.wrongEmployers, passed: r.wrongEmployers === 0, sample_n: r.mails, note: `${r.wrongEmployers} mails proven for an employer the sender is not.` },
    ]
    const { error } = await db.from('measure_runs').insert(rows)
    if (error) throw new Error('could not record the runs')
  }
  if (r.mismatches.length || r.wrongEmployers) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
