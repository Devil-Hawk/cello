// Directive 20: every model call goes through a declared step. This test reads the
// source tree and fails on a raw call outside the model doors, the steps and the
// per-lane allowlists of lib/steps/allow.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ALLOWLIST } from './allow'
import { allowlistProblems, rawCallers, rawCallsIn, sourceFiles, STRICT } from './source'

const WEB_ROOT = path.resolve(__dirname, '../..')

describe('the scanner', () => {
  it('flags every raw call shape in a fixture string', () => {
    expect(rawCallsIn("const r = await callLlm(keys, { name: 'x' })")).toContain('callLlm(')
    expect(rawCallsIn('await callEmbedding(keys, { texts })')).toContain('callEmbedding(')
    expect(rawCallsIn('const m = new ChatOpenAI({ apiKey })')).toHaveLength(1)
    expect(rawCallsIn('const c = new Anthropic({ apiKey })')).toHaveLength(1)
    expect(rawCallsIn("import OpenAI from 'openai'")).toHaveLength(1)
    expect(rawCallsIn('await client.messages.create({})')).toEqual(['.messages.create('])
    expect(rawCallsIn('await client.chat.completions.create(body)')).toEqual(['.chat.completions.create('])
    expect(rawCallsIn("import { callLlm } from '@/lib/harness/llm'")).toHaveLength(1)
  })

  it('ignores a call that only a comment mentions', () => {
    expect(rawCallsIn('// callLlm(keys, opts) is the door\n/* new OpenAI({}) */\nconst x = 1')).toEqual([])
  })

  it('flags a planted callLlm( in a temp file under lib/', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'steps-source-'))
    try {
      mkdirSync(path.join(root, 'lib'), { recursive: true })
      writeFileSync(path.join(root, 'lib', 'planted.ts'), "export const x = () => callLlm(keys, { prompt: 'x', name: 'planted' })\n")
      writeFileSync(path.join(root, 'lib', 'fine.ts'), 'export const y = 1\n')
      const callers = rawCallers(sourceFiles(root))
      expect([...callers.keys()]).toEqual(['lib/planted.ts'])
      expect(allowlistProblems(callers, [], false)).toEqual([expect.stringContaining('lib/planted.ts makes a raw model call')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not scan the model doors, the steps or the factory', () => {
    const callers = rawCallers([
      { rel: 'lib/harness/llm.ts', text: 'callLlm(' },
      { rel: 'lib/harness/providers/openrouter.ts', text: "import OpenAI from 'openai'" },
      { rel: 'lib/steps/define.ts', text: 'callLlm(' },
      { rel: 'lib/models/factory.ts', text: 'new ChatOpenAI(' },
    ])
    expect(callers.size).toBe(0)
  })
})

describe('the allowlist rules', () => {
  const callers = new Map([['lib/a.ts', ['callLlm(']]])

  it('passes a raw caller that is listed with a reason', () => {
    expect(allowlistProblems(callers, [{ file: 'lib/a.ts', reason: 'moves in K99' }], false)).toEqual([])
  })

  it('fails an entry whose file no longer makes the call', () => {
    expect(allowlistProblems(new Map(), [{ file: 'lib/gone.ts', reason: 'x' }], false)).toEqual([expect.stringContaining('delete the entry')])
  })

  it('fails every entry once the rule is strict, except a permanent one', () => {
    const entries = [{ file: 'lib/a.ts', reason: 'x' }]
    expect(allowlistProblems(callers, entries, true)).toEqual([expect.stringContaining('the rule is strict')])
    expect(allowlistProblems(callers, [{ ...entries[0], permanent: true }], true)).toEqual([])
  })
})

describe('the real tree', () => {
  const files = sourceFiles(WEB_ROOT)
  const callers = rawCallers(files)

  it('read the source files', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('makes no raw model call outside the steps except what an allowlist names', () => {
    expect(allowlistProblems(callers, ALLOWLIST, STRICT)).toEqual([])
  })
})
