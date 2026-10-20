// Deep Agents or plain createAgent for Chat, decided by the numbers of the two reports a live run wrote.
//
//   npx --no-install tsx lib/chat/evals/decide.ts [free]
//
// Reads reports/<tier>-deep-runs.json and reports/<tier>-plain-runs.json (every run the live test made, oldest first;
// a lone reports/<tier>-<core>.json counts as one run), and for each model both cores ran prints the mean, lowest and
// highest of each number with the run count, then the pick. The pick is only "decided" with at least two runs of each
// core and ranges that do not overlap (any overlap, equal means included, is a tie inside the spread); otherwise it
// stays deep and says so. S21 is compared as the share of the expected parts right. It writes nothing. The switch itself is the owner's.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { decideCore, PLAIN_REMOVES, type CoreTotals } from './score'

interface ModelEntry {
  model: string
  s14: { right: number; cases: number; errored: number }
  s21: { share: number | null; cases: number; errored: number }
  injection: { violations: string[]; errored: number }
  promptTokensPerTurn: number | null
}
interface Report { models: ModelEntry[] }

export const totalsOf = (core: 'deep' | 'plain', m: ModelEntry): CoreTotals => ({ core, model: m.model, s14Right: m.s14.right, s21Share: m.s21.share ?? 0, injectionViolations: m.injection.violations.length, promptTokensPerTurn: m.promptTokensPerTurn })

const unread = (label: string, m: ModelEntry) => [
  m.s14.errored * 2 > m.s14.cases && `${label} S14 cannot be read (${m.s14.errored} of ${m.s14.cases} cases errored).`,
  m.s21.errored * 2 > m.s21.cases && `${label} S21 cannot be read (${m.s21.errored} of ${m.s21.cases} cases errored).`,
].filter((x): x is string => Boolean(x))

/** A model whose runs mostly errored in either core cannot be compared: the pick stays deep and says why. */
export function decideModel(deep: ModelEntry, plain: ModelEntry): { pick: 'deep' | 'plain'; why: string[] } {
  const blocked = [...unread('Deep', deep), ...unread('Plain', plain)]
  if (blocked.length) return { pick: 'deep', why: blocked }
  return decideCore(totalsOf('deep', deep), totalsOf('plain', plain))
}

export interface Spread { n: number; mean: number; min: number; max: number }
const spreadOf = (xs: number[]): Spread => ({ n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) })
/** The two runs' ranges share a point: one more run could put either core ahead. */
const overlap = (a: Spread, b: Spread) => a.min <= b.max && b.min <= a.max
const dec = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

/** One core on one model over several runs. */
export function summarise(runs: ModelEntry[]) {
  const tokens = runs.map((r) => r.promptTokensPerTurn).filter((t): t is number => t !== null)
  return {
    s14: spreadOf(runs.map((r) => r.s14.right)),
    s21: spreadOf(runs.map((r) => r.s21.share ?? 0)),
    violations: Math.max(...runs.map((r) => r.injection.violations.length)),
    tokens: tokens.length === runs.length ? spreadOf(tokens) : null,
  }
}

/** Deep or plain over every run of each. Plain wins only when decideCore says so on the means AND no gap the runs rest on sits inside their own spread. */
export function decideRuns(deepRuns: ModelEntry[], plainRuns: ModelEntry[]): { pick: 'deep' | 'plain'; decided: boolean; why: string[] } {
  const blocked = [...deepRuns.flatMap((r) => unread('Deep', r)), ...plainRuns.flatMap((r) => unread('Plain', r))]
  if (blocked.length) return { pick: 'deep', decided: false, why: [...new Set(blocked)] }
  const d = summarise(deepRuns)
  const p = summarise(plainRuns)
  const base = decideCore(
    { core: 'deep', model: deepRuns[0].model, s14Right: dec(d.s14.mean), s21Share: dec(d.s21.mean, 2), injectionViolations: 0, promptTokensPerTurn: d.tokens ? Math.round(d.tokens.mean) : null },
    { core: 'plain', model: plainRuns[0].model, s14Right: dec(p.s14.mean), s21Share: dec(p.s21.mean, 2), injectionViolations: p.violations, promptTokensPerTurn: p.tokens ? Math.round(p.tokens.mean) : null }
  )
  const why = base.why.map((w) => `${w} (means over ${deepRuns.length} deep and ${plainRuns.length} plain runs)`)
  if (Math.min(deepRuns.length, plainRuns.length) < 2) return { pick: 'deep', decided: false, why: [...why, `Not decided: ${deepRuns.length} deep and ${plainRuns.length} plain runs. One run of each is one sample; the same model on the same cases has moved by several cases between runs.`] }
  const noise = [
    overlap(d.s14, p.s14) && `S14 ranges overlap (deep ${d.s14.min} to ${d.s14.max}, plain ${p.s14.min} to ${p.s14.max}).`,
    overlap(d.s21, p.s21) && `S21 ranges overlap (deep ${dec(d.s21.min, 2)} to ${dec(d.s21.max, 2)}, plain ${dec(p.s21.min, 2)} to ${dec(p.s21.max, 2)}).`,
  ].filter((x): x is string => Boolean(x))
  // Plain wholly below deep on a number settles "keep deep" for good: plain needs to match on every number, so a tie on another one cannot flip it.
  const behind = (a: Spread, b: Spread) => b.max < a.min
  if (noise.length && !(behind(d.s14, p.s14) || behind(d.s21, p.s21))) return { pick: 'deep', decided: false, why: [...why, `Not decided: the gap between the cores is inside the spread of the runs. ${noise.join(' ')}`] }
  return { pick: base.pick, decided: true, why }
}

function readRuns(tier: string, core: string): Report[] {
  const dir = path.join(__dirname, 'reports')
  const runs = path.join(dir, `${tier}-${core}-runs.json`)
  if (existsSync(runs)) return (JSON.parse(readFileSync(runs, 'utf8')) as { runs: Report[] }).runs
  return [JSON.parse(readFileSync(path.join(dir, `${tier}-${core}.json`), 'utf8'))]
}

const fmt = (s: Spread, d = 1) => `${dec(s.mean, d)} (lowest ${dec(s.min, d)}, highest ${dec(s.max, d)})`

function main() {
  const tier = process.argv[2] ?? 'free'
  const deep = readRuns(tier, 'deep')
  const plain = readRuns(tier, 'plain')
  const models = [...new Set(deep.flatMap((r) => r.models.map((m) => m.model)))]
  for (const model of models) {
    const dr = deep.flatMap((r) => r.models.filter((m) => m.model === model))
    const pr = plain.flatMap((r) => r.models.filter((m) => m.model === model))
    if (!pr.length) { console.log(`${model}: plain did not run this model.`); continue }
    const { pick, decided, why } = decideRuns(dr, pr)
    console.log(`${model}: ${pick}${decided ? ' (decided)' : ' (not decided)'}${why.length ? `\n  ${why.join('\n  ')}` : ''}`)
    for (const [label, runs] of [['deep', dr], ['plain', pr]] as const) {
      const s = summarise(runs)
      console.log(`  ${label}, ${runs.length} runs: S14 right of ${runs[0].s14.cases} ${fmt(s.s14)}; S21 share of expected parts right ${fmt(s.s21, 2)}; injection violations, most in a run ${s.violations}; prompt tokens per turn ${s.tokens ? fmt(s.tokens, 0) : 'cannot read'}`)
    }
  }
  console.log(`Plain would remove: ${PLAIN_REMOVES.join('; ')}. The switch is the owner's.`)
}

if (process.argv[1]?.endsWith('evals/decide.ts')) main()
