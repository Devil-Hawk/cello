// Deep Agents or plain createAgent for Chat, decided by the numbers of the two reports a live run wrote.
//
//   npx --no-install tsx lib/chat/evals/decide.ts [free]
//
// Reads reports/<tier>-deep.json and reports/<tier>-plain.json, runs decideCore for each model both cores ran, and
// prints the pick and what plain would remove. It writes nothing. The switch itself is the owner's.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decideCore, PLAIN_REMOVES, type CoreTotals } from './score'

interface ModelEntry {
  model: string
  s14: { right: number; cases: number; errored: number }
  s21: { right: number; cases: number; errored: number }
  injection: { violations: string[]; errored: number }
  promptTokensPerTurn: number | null
}
interface Report { models: ModelEntry[] }

export const totalsOf = (core: 'deep' | 'plain', m: ModelEntry): CoreTotals => ({ core, model: m.model, s14Right: m.s14.right, s21Right: m.s21.right, injectionViolations: m.injection.violations.length, promptTokensPerTurn: m.promptTokensPerTurn })

/** A model whose runs mostly errored in either core cannot be compared: the pick stays deep and says why. */
export function decideModel(deep: ModelEntry, plain: ModelEntry): { pick: 'deep' | 'plain'; why: string[] } {
  const unread = (label: string, m: ModelEntry) => [
    m.s14.errored * 2 > m.s14.cases && `${label} S14 cannot be read (${m.s14.errored} of ${m.s14.cases} cases errored).`,
    m.s21.errored * 2 > m.s21.cases && `${label} S21 cannot be read (${m.s21.errored} of ${m.s21.cases} cases errored).`,
  ].filter((x): x is string => Boolean(x))
  const blocked = [...unread('Deep', deep), ...unread('Plain', plain)]
  if (blocked.length) return { pick: 'deep', why: blocked }
  return decideCore(totalsOf('deep', deep), totalsOf('plain', plain))
}

function main() {
  const tier = process.argv[2] ?? 'free'
  const read = (core: string): Report => JSON.parse(readFileSync(path.join(__dirname, 'reports', `${tier}-${core}.json`), 'utf8'))
  const deep = read('deep')
  const plain = read('plain')
  for (const d of deep.models) {
    const p = plain.models.find((m) => m.model === d.model)
    if (!p) { console.log(`${d.model}: plain did not run this model.`); continue }
    const { pick, why } = decideModel(d, p)
    console.log(`${d.model}: ${pick}${why.length ? `\n  ${why.join('\n  ')}` : ''}`)
    console.log(`  deep: S14 ${d.s14.right}/${d.s14.cases}, S21 parts right ${d.s21.right}, injection violations ${d.injection.violations.length}, prompt tokens per turn ${d.promptTokensPerTurn ?? 'cannot read'}`)
    console.log(`  plain: S14 ${p.s14.right}/${p.s14.cases}, S21 parts right ${p.s21.right}, injection violations ${p.injection.violations.length}, prompt tokens per turn ${p.promptTokensPerTurn ?? 'cannot read'}`)
  }
  console.log(`Plain would remove: ${PLAIN_REMOVES.join('; ')}. The switch is the owner's.`)
}

if (process.argv[1]?.endsWith('evals/decide.ts')) main()
