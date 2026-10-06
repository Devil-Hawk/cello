// Memory extraction (prompts/memory_extract.md) through the real mem0 Memory:
// its own extraction prompt, an in-memory vector store, a hash embedder, and a
// free model behind the same kind of delegate the product uses. The question is
// what gets stored from one user and assistant exchange. Facts only Cello said
// must not be stored (checked on two draws), and what the person said should be.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Memory } from 'mem0ai/oss'
import type { BaseMessage } from '@langchain/core/messages'
import { applyPolicy, loadModeDoc } from '@/lib/harness/prompts'
import { round, type CaseResult, type SuiteCtx, type SuiteResult } from '../lib/report'
import { pick, readJson } from './common'

interface Case {
  id: string
  user: string
  assistant: string
  expected: string[][]
  forbidden: string[]
  quick?: boolean
}

const DIMS = 64

/** A bag-of-words hash embedding: enough for mem0's dedup and search to work, with no model. */
function embed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0)
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[createHash('md5').update(w).digest()[0] % DIMS] += 1
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}
const hashEmbedder = {
  embedQuery: async (t: string) => embed(t),
  embedDocuments: async (ts: string[]) => ts.map(embed),
}

const roleOf = (m: BaseMessage): 'system' | 'user' | 'assistant' => {
  const t = m.getType()
  return t === 'system' ? 'system' : t === 'ai' ? 'assistant' : 'user'
}

async function storedMemories(ctx: SuiteCtx, c: Case, sample: number): Promise<string[] | null> {
  let failed = false
  const delegate = {
    async invoke(messages: BaseMessage[]): Promise<{ content: string }> {
      let msgs = messages.map((m) => ({ role: roleOf(m), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
      // The product's own path: callLlm adds the policy to a library-built message list.
      if (ctx.variant === 'after') msgs = applyPolicy({ messages: msgs }).opts.messages ?? msgs
      const r = await ctx.free.chat({ model: ctx.generator, messages: msgs, temperature: 0, maxTokens: 800, json: true, sample })
      if (!r.content) {
        failed = true
        return { content: '{"memory": []}' }
      }
      return { content: r.content }
    },
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'cello-mem-eval-'))
  const memory = new Memory({
    embedder: { provider: 'langchain', config: { model: hashEmbedder } },
    llm: { provider: 'langchain', config: { model: delegate } },
    vectorStore: { provider: 'memory', config: { collectionName: 'eval', dimension: DIMS, dbPath: path.join(dir, 'vectors.db') } },
    disableHistory: true,
    historyDbPath: path.join(dir, 'history.db'),
    ...(ctx.variant === 'after' ? { customInstructions: loadModeDoc('memory_extract') } : {}),
  })
  await memory.add(
    [
      { role: 'user', content: c.user },
      { role: 'assistant', content: c.assistant },
    ],
    { userId: 'eval-user', infer: true }
  )
  if (failed) return null
  const all = await memory.getAll({ filters: { user_id: 'eval-user' } })
  return all.results.map((r) => r.memory)
}

export async function run(ctx: SuiteCtx): Promise<SuiteResult> {
  const { cases } = readJson<{ cases: Case[] }>('data/memory.json')
  const samples = ctx.quick ? 1 : 2
  const results: CaseResult[] = []
  const startRequests = ctx.free.requests
  let groups = 0
  let hit = 0

  for (const c of pick(cases, ctx)) {
    let clean = true
    let answered = true
    const notes: string[] = []
    for (let s = 0; s < samples; s += 1) {
      const mem = await storedMemories(ctx, c, s).catch(() => null)
      if (mem === null) {
        answered = false
        break
      }
      const joined = mem.map((m) => m.toLowerCase())
      const dirty = c.forbidden.some((f) => (f === '*' ? mem.length > 0 : joined.some((m) => m.includes(f))))
      if (dirty) {
        clean = false
        notes.push(`stored: ${mem.join(' | ').slice(0, 140)}`)
      }
      for (const alt of c.expected) {
        groups += 1
        if (joined.some((m) => alt.some((a) => m.includes(a)))) hit += 1
      }
    }
    if (!answered) {
      results.push({ id: c.id, checks: {}, skipped: true })
      continue
    }
    results.push({ id: c.id, checks: { forbiddenAbsent: clean }, note: notes[0] })
  }

  const counted = results.filter((r) => !r.skipped)
  return {
    prompt: 'memory_extract',
    variant: ctx.variant,
    quick: ctx.quick,
    generator: ctx.generator,
    judge: null,
    metrics: {
      forbidden_clean: round(counted.filter((r) => r.checks.forbiddenAbsent).length / Math.max(1, counted.length)),
      forbidden_dirty: counted.filter((r) => !r.checks.forbiddenAbsent).length,
      recall: round(hit / Math.max(1, groups)),
    },
    cases: results,
    requests: ctx.free.requests - startRequests,
    at: new Date().toISOString(),
  }
}
