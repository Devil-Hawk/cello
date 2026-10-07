// Every ":free" model id written in the source must still be on OpenRouter's live free list, so an eval
// never spends its budget on a retired id. Public GET, no key. OPT-IN, LIVE: not in CI, because an
// upstream retirement must not turn unrelated pull requests red.
//   RUN_AGENT_EVALS=1 ./node_modules/.bin/vitest run lib/evals/agent/free-ids.eval.test.ts

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUN_LIVE } from './free.eval'

const ROOT = path.resolve(__dirname, '../../..')
const SKIP = new Set(['node_modules', '.cache', '.next', 'reports'])

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (/\.(ts|tsx|json|example)$/.test(e.name) && !e.name.endsWith('.test.ts')) yield p
  }
}

const live = async (url: string, keep: (m: { id: string; supported_parameters?: string[] }) => boolean): Promise<string[]> => {
  const { data } = (await (await fetch(url)).json()) as { data: { id: string; supported_parameters?: string[] }[] }
  return data.filter((m) => m.id.endsWith(':free') && keep(m)).map((m) => m.id)
}

describe.skipIf(!RUN_LIVE)('free model ids in the source', () => {
  it('are all on the live list', async () => {
    const served = new Set([
      ...(await live('https://openrouter.ai/api/v1/models', (m) => !!m.supported_parameters?.includes('tools'))),
      ...(await live('https://openrouter.ai/api/v1/embeddings/models', () => true)),
    ])
    const written = new Set<string>()
    for (const dir of ['lib', 'scripts', 'app']) {
      for (const f of files(path.join(ROOT, dir))) for (const m of readFileSync(f, 'utf8').matchAll(/[\w.-]+\/[\w.-]+:free/g)) written.add(m[0])
    }
    for (const m of readFileSync(path.join(ROOT, '.env.example'), 'utf8').matchAll(/[\w.-]+\/[\w.-]+:free/g)) written.add(m[0])
    expect([...written].filter((id) => !served.has(id))).toEqual([])
  }, 60_000)
})
