// The daily digest over six fixture states. No model is involved, so this runs
// anywhere and the numbers are exact.
//
//   sh scripts/evals/outputs/run.sh digest --label before|after
//
// before: release/1's composeDigest (legacy/digest.ts) over an in-memory database.
// after:  loadDigestState and buildDigest over the same tables.
//
// Checks: no applied, closed or stale role among the new roles; every item has a
// reason and a link; the numbers are exact; no long dash or filler; an empty
// digest says what Cello is watching or what to do next; thin data is said to be thin.

import { composeDigest } from '@/lib/digest/compose'
import { legacyComposeDigest } from './legacy/digest'
import { fakeAdmin } from './lib/fake-admin'
import { load, metricFrom, report, run, start } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  name: string
  now: string
  tables: Record<string, Record<string, unknown>[]>
  expect: {
    newRolesExclude?: string[]
    mustMention?: string[]
    workingNumbers?: { sent: number; replies?: number }
    empty?: boolean
    companyCount?: number
    thin?: boolean
    maxRoles?: number
  }
}

interface Shape {
  subject: string
  text: string
  html: string
  /** The role lines, as shown. */
  roleLines: string[]
  /** Every line of the digest that is an item. */
  itemCount: number
  itemsWithLink: number
  itemsWithReason: number
}

function shapeAfter(d: Awaited<ReturnType<typeof composeDigest>>): Shape {
  const items = d.sections.filter((s) => s.id !== 'working').flatMap((s) => s.items.map((i) => ({ ...i, section: s.id })))
  const roles = items.filter((i) => i.section === 'new_roles')
  return {
    subject: d.subject,
    text: d.text,
    html: d.html,
    roleLines: roles.map((r) => r.text),
    itemCount: items.length,
    itemsWithLink: items.filter((i) => i.href).length,
    itemsWithReason: roles.filter((r) => r.text.includes(':')).length,
  }
}

function shapeBefore(d: Awaited<ReturnType<typeof legacyComposeDigest>>): Shape {
  const li = d.html.match(/<li>/g)?.length ?? 0
  const links = d.html.match(/<a href/g)?.length ?? 0
  return {
    subject: d.subject,
    text: d.text,
    html: d.html,
    roleLines: d.topJobs.map((j) => `${j.title}${j.companyName ? ` @ ${j.companyName}` : ''}`),
    itemCount: li,
    itemsWithLink: links,
    // release/1 printed a score, never a reason.
    itemsWithReason: 0,
  }
}

async function main() {
  const args = start()
  const items = load<Item>('digest', args)
  const rows: Record<string, { id: string; ok: boolean }[]> = {}
  const add = (check: string, id: string, ok: boolean) => (rows[check] ??= []).push({ id, ok })
  const out: unknown[] = []

  for (const item of items) {
    const admin = fakeAdmin(structuredClone(item.tables)) as never
    const now = Date.parse(item.now)
    const realNow = Date.now
    Date.now = () => now
    let shape: Shape
    try {
      shape = args.label === 'before' ? shapeBefore(await legacyComposeDigest(admin, 'user-1')) : shapeAfter(await composeDigest(admin, 'user-1'))
    } finally {
      Date.now = realNow
    }
    const all = `${shape.subject}\n${shape.text}\n${shape.html}`
    const e = item.expect

    if (e.newRolesExclude) add('no applied, closed or stale role in new roles', item.id, !e.newRolesExclude.some((t) => shape.roleLines.some((l) => l.includes(t))))
    if (shape.roleLines.length > 0) {
      add('every role has a reason', item.id, shape.itemsWithReason >= shape.roleLines.length)
      add('every item has a link', item.id, shape.itemsWithLink >= shape.itemCount)
    }
    if (e.workingNumbers) {
      const w = e.workingNumbers
      add('numbers exact', item.id, shape.text.includes(`sent ${w.sent} email`) && (w.replies === undefined || shape.text.includes(`${w.replies} repl`)))
    }
    add('no long dash or filler', item.id, !/[–—]/.test(all) && !/enjoy the calm|great job|keep it up/i.test(all))
    if (e.empty) {
      const names = e.companyCount ? `watching ${e.companyCount} compan` : 'Add companies'
      add('empty digest names what is watched or the next step', item.id, shape.text.includes(names))
    }
    if (e.thin) add('thin data is said to be thin', item.id, /too few to tell/i.test(shape.text))
    if (e.mustMention) add('mentions what is there', item.id, e.mustMention.every((m) => all.includes(m)))
    if (e.maxRoles) add('at most five roles', item.id, shape.roleLines.length <= e.maxRoles)
    out.push({ id: item.id, name: item.name, subject: shape.subject })
    console.log(`${item.id} ${shape.subject}`)
  }

  const metrics: Metric[] = Object.entries(rows).map(([name, r]) => metricFrom(name, r))
  report('digest', args, 'no judge: fixture checks', metrics, out)
}

run(main)
