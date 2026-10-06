// What the page check lets through when the model is perfect: for every real
// title on every saved page, point at the link that carries it and see whether
// verifyModelJobs keeps it. The recall a model can reach is capped by this, so
// it is reported beside the model numbers (no model is called).
//
//   cd apps/web && npx tsx scripts/eval-ingest/ceiling.ts

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { snapshotPage, verifyModelJobs } from '../../lib/ingest/snapshot'

interface Entry {
  id: string
  kind: string
  url: string
  file: string
  truth: string[] | null
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const entries = JSON.parse(readFileSync(path.join(__dirname, 'pages.json'), 'utf8')) as Entry[]
let truthTotal = 0
let reachable = 0
const rows: Record<string, unknown>[] = []

for (const e of entries) {
  if (!e.truth || e.kind === 'single') continue
  const snap = snapshotPage(readFileSync(path.join(__dirname, 'pages', e.file), 'utf8'), e.url)
  // A title two postings share is one title to find; the scorer counts it once too.
  const titles = [...new Map(e.truth.map((t) => [norm(t), t])).values()]
  const jobs = titles.map((title) => {
    // The link a careful model would point at: label holds the title, else the first link whose card does.
    const t = norm(title)
    // The shortest label that holds the title: "Forward Deployed Engineer" is also inside
    // "Forward Deployed Engineer, Federal", and the longer one is a different posting.
    let n = 0
    let best = Infinity
    snap.links.forEach((l, i) => {
      const label = norm(l.label)
      if (label.includes(t) && label.length < best) {
        best = label.length
        n = i + 1
      }
    })
    if (!n) n = snap.links.findIndex((l) => norm(l.context).includes(t)) + 1
    return { title, link: n > 0 ? n : null }
  })
  const { kept } = verifyModelJobs({ page_kind: 'listing', jobs }, snap)
  const got = new Set(kept.map((j) => norm(j.title)))
  const ok = titles.filter((t) => got.has(norm(t))).length
  truthTotal += titles.length
  reachable += ok
  const missed = titles.filter((t) => !got.has(norm(t)))
  rows.push({ page: e.id, ...(missed.length ? { missed } : {}), truth: titles.length, reachable: ok, links: snap.links.length, truncated: snap.truncated, textChars: snap.text.length })
}
console.log(JSON.stringify({ rows, ceilingRecall: Number((reachable / truthTotal).toFixed(3)), reachable, truthTotal }, null, 1))
