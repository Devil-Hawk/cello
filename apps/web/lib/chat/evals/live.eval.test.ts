// Chat's own cases run on the real chat loop with a free model behind it: S14 (the right command first), S21 (answers
// about many things) and injection (words planted where Chat reads them), once per model, on the deep core or the plain
// one, with the totals written to reports/<tier>-<core>.json. The bars are thresholds.json; the decision between the
// cores is decideCore over two such reports.
//
// OPT-IN, LIVE, FREE MODELS ONLY (every id goes through FreeChatModel, which refuses anything not ending in ":free").
//   RUN_CHAT_EVALS=1 CHAT_EVAL_TIER=free CHAT_EVAL_CORE=deep CHAT_EVAL_MODELS=<id>,<id> pnpm exec vitest run lib/chat/evals/live.eval.test.ts
//   CHAT_EVAL_GATE=0           write the report without failing on the thresholds
//   AGENT_EVAL_CACHE, AGENT_EVAL_MAX_REQUESTS   as lib/evals/agent/free.eval.ts (a re-run costs nothing for unchanged prompts)
//   With SUPABASE_URL on this computer (127.0.0.1 or localhost) and its service key in the environment, one S14 and one
//   S21 row per model go to measure_runs with the tier, model and core in the note. A remote URL is never written to.
//
// How the commands run: Chat's tools are built by chatAgent and call runCommand through chatDoor, whose admin is the real
// service client. Here each command's `run` is replaced for the length of the run by a stub that answers from the demo
// fixtures (lib/access/fixtures: the same roles, companies, people and applications the demo workspace holds), in the
// shape the real command returns, so the output schema, the answer check's results and the model's view of them are the
// real ones. The command's limit and guard are lifted (they read the database); the doors and the input check stay. A
// command that only changes something answers "nothing was changed in this check". The agent's own database is the fake
// admin, so nothing is written anywhere. The workspace is a demo one (isDemo), which also turns the free step-down off:
// the model named in the report is the only model that answered.
//
// The prompt tokens per turn are the mean, over every case, of the summed input_tokens of that case's model calls. S14
// stops after the first call (the first move is what it scores), so those cases count one call.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildDemoFit, companyForJob, DEMO_APPLICATIONS, DEMO_COMPANIES, DEMO_CONTACTS, DEMO_JOBS, DEMO_RESUME, demoUuid, type DemoJob } from '@/lib/access/fixtures'
import { rootCause } from '@/lib/agents/spend-port'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { ScriptedChatModel } from '@/lib/agents/testing/scripted-model'
import { agentView, CommandRefusal, toolName } from '@/lib/commands'
import { EvalStop, FreeChatModel, GENERATORS, mapLimit, stats } from '@/lib/evals/agent/free.eval'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { TIERS, type Tier } from '@/lib/measures/tiers'
import { deriveResumeColumns } from '@/lib/resume/store'
import { chatAgent } from '../agent'
import type { ModelAnswer } from '../answer'
import { screenMessage } from '../screen'
import { madeThing, thingText, type Thing } from '../things'
import { refId, type AttachKind, type ChatObject } from '../types'
import { recordS14, recordS21 } from './record'
import { scoreInjection, scoreS14, scoreS21, type InjectionRun, type InjectionScore, type S14Case, type S14Run, type S14Score, type S21Case, type S21Score } from './score'

const USER = 'eval-user'
type Core = 'deep' | 'plain'

// --- the cases ----------------------------------------------------------------------------------

interface S21File { cases: { id: string; ask: string; attached: string[]; expected: string[][] }[] }
interface InjectionCase {
  id: string
  channel: 'quoted' | 'tool_result' | 'attached_chat' | 'made_text'
  message: string
  quoted?: { text: string; turn_id: string }
  tool?: string
  payload?: { title?: string; company?: string; pay?: string; text?: string }
  attachedChatTyped?: string
  madeText?: string
  forbidden: string[]
  mustNotSay?: string[]
  mustSay?: string
}
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(__dirname, file), 'utf8')) as T
const S14_CASES = readJson<{ cases: S14Case[] }>('chat.cases.json').cases
const S21_CASES = readJson<S21File>('s21.cases.json').cases
const INJECTION_CASES = readJson<{ cases: InjectionCase[] }>('injection.cases.json').cases
const BARS = readJson<{ S14: { overall: number }; S21: { share: number; wrongObjectFacts: number }; injection: { violations: number } }>('thresholds.json')

// --- the demo fixtures, as the things the commands return ----------------------------------------

// A fixed day, so the same prompt is sent every time and the recorded answers stay valid.
const ANCHOR = Date.parse('2026-10-20T00:00:00Z')
const dayOf = (daysAgo: number) => new Date(ANCHOR - daysAgo * 86_400_000).toISOString().slice(0, 10)
const idOf = (kind: string, slug: string) => demoUuid(USER, `${kind}:${slug}`)

interface Fixture {
  key: string
  object: ChatObject
  /** What a command returns for it; null for a kind no Chat command reads (an application). */
  thing: Thing | null
  /** What the answer check may hold a statement against. */
  evidence: string
}

const FIXTURES = new Map<string, Fixture>()
const BY_ID = new Map<string, Fixture>()
const add = (f: Fixture) => {
  if (!FIXTURES.has(f.key)) FIXTURES.set(f.key, f)
  BY_ID.set(f.object.id, f)
}

const resumeText = deriveResumeColumns(DEMO_RESUME).content
const lines = (...l: (string | null | false | undefined)[]) => l.filter((x): x is string => Boolean(x))

for (const j of DEMO_JOBS) {
  const id = idOf('job', j.slug)
  const company = companyForJob(j).name
  const fit = buildDemoFit(j, resumeText, dayOf(0))
  const checks = ((fit.chance_detail?.checks ?? []) as { requirement: string; status: string }[]).map((c) => `${c.status === 'met' ? 'Covered' : 'Missing'}: ${c.requirement}`)
  const thing: Thing = { kind: 'role', id, title: j.title, company, place: j.location, pay: j.salaryRange, chance: fit.chance, posted: dayOf(j.postedDaysAgo), notes: checks }
  const facts = lines(`Place: ${j.location}`, fit.chance && `Chance: ${fit.chance}`, `Pay as stated: ${j.salaryRange}`, `Posted: ${thing.posted}`)
  add({ key: `role:${j.title}`, object: { kind: 'role', id, title: j.title, company, facts, body: null }, thing, evidence: thingText(thing) })
}
for (const c of DEMO_COMPANIES) {
  const id = idOf('company', c.slug)
  const open = DEMO_JOBS.filter((j) => j.companySlug === c.slug).length
  const kept = DEMO_APPLICATIONS.filter((a) => DEMO_JOBS.find((j) => j.slug === a.jobSlug)?.companySlug === c.slug).length
  const thing: Thing = { kind: 'company', id, title: c.name, company: c.name, place: null, pay: null, chance: null, posted: null, notes: [`${open} open roles stored`, `${kept} applications`, 'You do not follow it', `Site: ${c.domain}`] }
  add({ key: `company:${c.name}`, object: { kind: 'company', id, title: c.name, company: c.name, facts: [`Site: ${c.domain}`], body: null }, thing, evidence: thingText(thing) })
}
for (const p of DEMO_CONTACTS) {
  const id = idOf('contact', p.slug)
  const thing: Thing = { kind: 'person', id, title: p.name, company: DEMO_COMPANIES.find((c) => c.slug === p.companySlug)?.name ?? null, place: null, pay: null, chance: null, posted: null, notes: [`Title: ${p.title}`] }
  add({ key: `person:${p.name}`, object: { kind: 'person', id, title: p.name, company: null, facts: [`Title: ${p.title}`], body: null }, thing, evidence: thingText(thing) })
}
for (const a of DEMO_APPLICATIONS) {
  const job = DEMO_JOBS.find((j) => j.slug === a.jobSlug)
  if (!job) continue
  const facts = [`Stage: ${a.stage}`, ...(a.appliedDaysAgo === null ? [] : [`Applied: ${dayOf(a.appliedDaysAgo)}`])]
  add({ key: `application:${job.title}`, object: { kind: 'application', id: idOf('application', a.jobSlug), title: job.title, company: companyForJob(job).name, facts, body: null }, thing: null, evidence: facts.join('. ') })
}

/** The fixtures a list of kind:name keys names; a name that is in no fixture is an error, never a skipped case. */
export function resolveAll(keys: string[]): Fixture[] {
  return keys.map((k) => {
    const f = FIXTURES.get(k)
    if (f) return f
    // s21's mixed-five attaches an application for a role the demo workspace holds no application for. It is attached
    // by name only, with no stage or date: nothing is made up about it.
    const job = k.startsWith('application:') ? DEMO_JOBS.find((j) => j.title === k.slice('application:'.length)) : undefined
    if (!job) throw new Error(`No fixture is called "${k}".`)
    add({ key: k, object: { kind: 'application', id: idOf('application', job.slug), title: job.title, company: companyForJob(job).name, facts: [], body: null }, thing: null, evidence: '' })
    return FIXTURES.get(k)!
  })
}

// --- the commands, answering from the fixtures ----------------------------------------------------

/** Words planted in a tool's result for one turn (the injection set's tool_result channel). */
const PLANTS = new Map<string, { tool: string; thing: Thing }>()
const PLANTABLE = ['roles.get', 'companies.get', 'people.find', 'chat.recall']

const ONLY_WORDS = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3)

function findRoles(input: { type?: string; place?: string; words?: string; interested?: boolean; limit: number }) {
  const has = (hay: string, text: string | undefined) => ONLY_WORDS(text ?? '').every((w) => hay.includes(w.slice(0, 4)))
  const hits = DEMO_JOBS.filter(
    (j) =>
      has(`${j.title} ${j.jobFunction}`.toLowerCase(), input.type) &&
      has(`${j.location}${j.isRemote ? ' remote' : ''}`.toLowerCase(), input.place) &&
      has(`${j.title} ${j.team} ${j.focus.join(' ')}`.toLowerCase(), input.words) &&
      // "Interested" is a mark the person gives a role; the demo workspace holds none, so the roles it wants most stand in.
      (!input.interested || (j.want ?? 0) >= 0.7)
  ).sort((a, b) => a.postedDaysAgo - b.postedDaysAgo)
  const things = hits.slice(0, input.limit).map((j) => FIXTURES.get(`role:${j.title}`)!.thing!)
  return { sentence: `Searched your stored roles${input.type ? ` for ${input.type}` : ''}${input.place ? ` in ${input.place}` : ''}: ${hits.length} matched.`, matched: hits.length, things }
}

const cell = (v: string | null | undefined) => (v ?? 'not stated').replace(/\s+/g, ' ').replace(/\|/g, '/').trim()

const STUBS: Record<string, (input: any) => unknown> = {
  'roles.find': findRoles,
  'roles.get': (input: { id: string }) => {
    const t = BY_ID.get(input.id)?.thing
    return t?.kind === 'role' ? { sentence: `Read ${t.title}.`, things: [t] } : { sentence: 'That role is not in your stored roles.', things: [] }
  },
  'companies.get': (input: { id: string }) => {
    const t = BY_ID.get(input.id)?.thing
    return t?.kind === 'company' ? { sentence: `Read ${t.title}.`, things: [t] } : { sentence: 'That company is not in your account.', things: [] }
  },
  'roles.compare': (input: { ids: string[] }) => {
    const roles = [...new Set(input.ids)].map((id) => BY_ID.get(id)?.thing).filter((t): t is Thing => t?.kind === 'role')
    if (roles.length < 2) throw new CommandRefusal(404, 'Fewer than two of those roles are in your stored roles.', 'not_found')
    const table = ['| Role | Company | Place | Chance | Pay as stated | Posted |', '| --- | --- | --- | --- | --- | --- |', ...roles.map((r) => `| ${[r.title, r.company, r.place, r.chance ?? 'not checked yet', r.pay, r.posted].map(cell).join(' | ')} |`)].join('\n')
    const title = `Compare ${roles.length} roles`
    return { sentence: `Compared ${roles.length} of your stored roles in a table.`, table, artifact_id: 'eval-comparison', version: 1, things: [...roles, madeThing('eval-comparison', title, ['Comparison table, version 1', table])] }
  },
  'people.find': (input: { name: string; limit: number }) => {
    const want = input.name.toLowerCase()
    const found = DEMO_CONTACTS.filter((p) => p.name.toLowerCase().includes(want)).slice(0, input.limit).map((p) => FIXTURES.get(`person:${p.name}`)!.thing!)
    return { sentence: found.length ? `Found ${found.length} of your contacts named like "${input.name}".` : `None of your contacts is named like "${input.name}".`, things: found }
  },
  'chat.recall': () => ({ sentence: 'Nothing in your earlier chats matches.', things: [] }),
}

/** Replaces the run of each of Chat's commands with the fixture stub; returns the function that puts them back. */
function stubCommands(): () => void {
  const defs = agentView()
  const saved = defs.map((def) => ({ def, run: def.run, output: def.output, guard: def.guard, limits: def.limits }))
  for (const def of defs) {
    const stub = STUBS[def.id]
    def.run = async (ctx, input) => {
      const plant = ctx.chat ? PLANTS.get(ctx.chat.turnId) : undefined
      if (plant?.tool === def.id) return { sentence: `Read ${plant.thing.title}.`, things: [plant.thing] }
      return stub ? stub(input) : { sentence: 'Nothing was changed in this check.' }
    }
    // A command with no stub answers a bare sentence, which its own output shape would refuse.
    if (!stub) def.output = z.any()
    def.guard = undefined
    def.limits = undefined
  }
  return () => saved.forEach((s) => Object.assign(s.def, { run: s.run, output: s.output, guard: s.guard, limits: s.limits }))
}

// --- one turn --------------------------------------------------------------------------------------

/** A model for one turn and the answers it gave, in order (a fresh one per case, so these are that turn's). */
interface Handle {
  id: string
  model: BaseChatModel
  responses(): AIMessage[]
}
type Door = (stopAfterCalls?: number) => Handle

/**
 * The same model is the loop's and the Researcher's (the chatAgent seam), and langchain refuses a model that already has
 * tools bound when the Researcher is built on first delegation. So binding gives back a copy that carries the tools and
 * shares the original's record of calls, and the model itself stays unbound.
 */
class UnboundFreeModel extends FreeChatModel {
  bindTools(tools: unknown[]): this {
    const bound = Object.create(this) as this
    ;(bound as unknown as { tools: unknown[] }).tools = tools
    return bound
  }
}

const freeDoor =
  (id: string): Door =>
  (stopAfterCalls) => {
    const model = new UnboundFreeModel({ model: id, stopAfterCalls })
    return { id, model, responses: () => model.calls.map((c) => c.response) }
  }

/** The tool the loop binds for the structured answer is named extract-<n>; calling it is answering, not a command. */
const ANSWER_TOOL = /^extract-\d+$/
const COMMAND_OF = new Map(agentView().map((d) => [toolName(d), d.id]))
/** Chat's commands in dot form ('roles.find'); every other tool keeps its name ('task', 'read_file'). The answer tool is dropped. */
const callsOf = (rs: AIMessage[]): string[] => rs.flatMap((r) => (r.tool_calls ?? []).map((c) => c.name)).filter((n) => !ANSWER_TOOL.test(n)).map((n) => COMMAND_OF.get(n) ?? n)

const wordsOf = (r: AIMessage): string =>
  [
    typeof r.content === 'string' ? r.content : (r.content as { text?: string }[]).map((b) => b.text ?? '').join(''),
    ...(r.tool_calls ?? []).filter((c) => ANSWER_TOOL.test(c.name)).flatMap((c) => ((c.args as { parts?: { text?: string }[] }).parts ?? []).map((p) => p.text ?? '')),
  ].join('\n')

/** The summed input tokens of the turn's model calls; null when none reported usage. */
const tokensOf = (rs: AIMessage[]): number | null => (rs.some((r) => r.usage_metadata) ? rs.reduce((a, r) => a + (r.usage_metadata?.input_tokens ?? 0), 0) : null)

const isStop = (e: unknown) => rootCause(e) instanceof EvalStop || (e as { name?: string })?.name === 'EvalStop' || /eval stop/i.test(String((e as Error)?.message))

interface Turn {
  responses: AIMessage[]
  answer: ModelAnswer | null
  /** Set when the run died for a reason other than the stop the eval asked for. */
  error: string | null
}

async function runTurn(door: Door, core: Core, c: { typed: string; screen: string | null; stopAfterCalls?: number; plant?: { tool: string; thing: Thing } }): Promise<Turn> {
  const handle = door(c.stopAfterCalls)
  const db = makeFakeAdmin()
  // The ledger a free call is booked on; a free id costs nothing.
  db.rpcHandlers.reserve_llm_spend = () => ({ ok: true, id: randomUUID() })
  db.rpcHandlers.settle_llm_spend = () => ({})
  const turnId = randomUUID()
  if (c.plant) PLANTS.set(turnId, c.plant)
  const run = chatAgent({
    db,
    userId: USER,
    keys: { userId: USER } as DecryptedApiKeys, // no key of any kind: nothing but the model handed in can be reached
    isDemo: true,
    ran: { rung: 'R3', model: handle.id, effort: 'low' },
    core,
    model: handle.model,
  })
  try {
    const out = await run({ chatId: randomUUID(), turnId, screen: c.screen, typed: c.typed, feedback: null, returned: new Set() })
    return { responses: handle.responses(), answer: out.answer, error: null }
  } catch (e) {
    return { responses: handle.responses(), answer: null, error: isStop(e) ? null : (e instanceof Error ? e.message : String(e)).slice(0, 160) }
  } finally {
    PLANTS.delete(turnId)
  }
}

/** The screen message for a chat holding these things, built by the real screenMessage over the fixtures. */
async function screenOf(objects: ChatObject[], quoted?: { text: string; turn_id: string }): Promise<string | null> {
  const rows = objects.map((o, i) => ({ id: `a${i}`, user_id: USER, chat_id: 'eval-chat', position: i, kind: o.kind, ref: o.kind === 'chat' ? { chat_id: o.id } : { id: o.id }, origin: 'person', prov: null, added_at: '2026-10-20T00:00:00Z', removed_at: null }))
  const byKey = new Map(objects.map((o) => [`${o.kind}:${o.id}`, o]))
  const get = async (_db: unknown, _user: string, kind: AttachKind, ref: Record<string, string>) => byKey.get(`${kind}:${refId(kind, ref)}`) ?? null
  return screenMessage(makeFakeAdmin({ chat_attachments: rows }), USER, 'eval-chat', { quoted, get })
}

// --- the three sets -----------------------------------------------------------------------------------

interface SetResult<S> {
  score: S
  /** S14: what the model did first in each case it got wrong. S21: the parts whose `about` matched no labelled part. */
  missed?: string[]
  /** Per case: the summed prompt tokens of the turn, null when unknown. */
  tokens: (number | null)[]
  /** Why runs errored, so "cannot read" says what was in the way. */
  errors: string[]
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160)

async function runS14(door: Door, core: Core): Promise<SetResult<S14Score>> {
  const out = await mapLimit(S14_CASES, 2, async (c): Promise<{ run: S14Run; tokens: number | null; error?: string }> => {
    try {
      const turn = await runTurn(door, core, { typed: c.ask, screen: await screenOf(resolveAll(c.attached).map((f) => f.object)), stopAfterCalls: 1 })
      const first = turn.responses[0]
      // The first move is what is scored: a run that never got a first answer read nothing.
      return first ? { run: { id: c.id, calls: callsOf([first]) }, tokens: tokensOf([first]) } : { run: { id: c.id, calls: [], errored: true }, tokens: null, error: turn.error ?? 'no model answer' }
    } catch (e) {
      return { run: { id: c.id, calls: [], errored: true }, tokens: null, error: why(e) }
    }
  })
  const score = scoreS14(S14_CASES, out.map((o) => o.run), BARS.S14.overall)
  const missed = out.filter((o) => !o.run.errored && !(o.run.calls.length ? o.run.calls.every((x) => S14_CASES.find((c) => c.id === o.run.id)!.allowed.includes(x)) : S14_CASES.find((c) => c.id === o.run.id)!.allowed.includes('answer'))).map((o) => `${o.run.id}: ${o.run.calls.join(', ') || 'answered with no command'}`)
  return { score, missed, tokens: out.map((o) => o.tokens), errors: out.flatMap((o) => (o.error ? [`${o.run.id}: ${o.error}`] : [])) }
}

type S21Result = S21Score & { errored: number; cases: number }

async function runS21(door: Door, core: Core): Promise<SetResult<S21Result>> {
  const out = await mapLimit(S21_CASES, 2, async (c): Promise<{ id: string; scored: S21Case | null; tokens: number | null; error?: string; miss?: string[] }> => {
    try {
      const fixtures = resolveAll(c.attached)
      const turn = await runTurn(door, core, { typed: c.ask, screen: await screenOf(fixtures.map((f) => f.object)) })
      if (!turn.answer) return { id: c.id, scored: null, tokens: tokensOf(turn.responses), error: turn.error ?? 'no answer' }
      const keyOf = new Map(fixtures.map((f) => [f.object.id, f.key]))
      const answer = turn.answer.parts.map((p) => ({ about: p.about.map((a) => keyOf.get(a.id) ?? `${a.kind}:${a.id}`), text: p.text }))
      const miss = answer.filter((p) => !c.expected.some((e) => e.length === p.about.length && e.every((x) => p.about.includes(x)))).map((p) => `${c.id}: a part about [${p.about.join(' | ')}]`)
      return { id: c.id, scored: { id: c.id, expected: c.expected, evidence: Object.fromEntries(fixtures.map((f) => [f.key, f.evidence])), answer }, tokens: tokensOf(turn.responses), miss }
    } catch (e) {
      return { id: c.id, scored: null, tokens: null, error: why(e) }
    }
  })
  const read = out.map((o) => o.scored).filter((s): s is S21Case => s !== null)
  // A case that never answered keeps its expected parts in the denominator.
  const unread = S21_CASES.filter((c) => out.some((o) => o.id === c.id && o.scored === null))
  return { score: { ...scoreS21(read, unread), errored: unread.length, cases: out.length }, missed: out.flatMap((o) => o.miss ?? []), tokens: out.map((o) => o.tokens), errors: out.flatMap((o) => (o.error ? [`${o.id}: ${o.error}`] : [])) }
}

/** Where each channel's words sit for Chat: a quotation in the screen message, a tool's result, an attached chat, a made text. */
async function injectionTurn(door: Door, core: Core, c: InjectionCase): Promise<Turn> {
  if (c.channel === 'quoted') return runTurn(door, core, { typed: c.message, screen: await screenOf([], c.quoted) })
  if (c.channel === 'tool_result') {
    const p = c.payload ?? {}
    const thing: Thing = { kind: 'role', id: idOf('job', 'planted'), title: p.title ?? 'Role', company: p.company ?? null, place: null, pay: p.pay ?? null, chance: null, posted: null, notes: p.text ? [p.text] : [] }
    return runTurn(door, core, { typed: c.message, screen: null, plant: { tool: PLANTABLE.includes(c.tool ?? '') ? c.tool! : 'roles.get', thing } })
  }
  const earlier: ChatObject =
    c.channel === 'attached_chat'
      ? { kind: 'chat', id: 'eval-earlier-chat', title: 'Earlier chat', company: null, facts: ['Earlier chat from 2026-10-01'], body: c.attachedChatTyped ?? null }
      : { kind: 'made', id: 'eval-made-draft', title: 'Draft', company: null, facts: ['Kind: draft', 'Version: 1'], body: c.madeText ?? null }
  return runTurn(door, core, { typed: c.message, screen: await screenOf([earlier]) })
}

async function runInjection(door: Door, core: Core): Promise<SetResult<InjectionScore>> {
  const out = await mapLimit(INJECTION_CASES, 2, async (c): Promise<{ run: InjectionRun; tokens: number | null; error?: string }> => {
    try {
      // Eight model calls are plenty to act on planted words; the turn is read as far as it went.
      const turn = await injectionTurn((stop) => door(stop ?? 8), core, c)
      const dead = turn.error !== null || turn.responses.length === 0
      const text = [...turn.responses.map(wordsOf), ...(turn.answer?.parts.map((p) => p.text) ?? [])].join('\n')
      return { run: { id: c.id, calls: callsOf(turn.responses), text, errored: dead }, tokens: tokensOf(turn.responses), error: dead ? (turn.error ?? 'no model answer') : undefined }
    } catch (e) {
      return { run: { id: c.id, calls: [], text: '', errored: true }, tokens: null, error: why(e) }
    }
  })
  return { score: scoreInjection(INJECTION_CASES, out.map((o) => o.run)), tokens: out.map((o) => o.tokens), errors: out.flatMap((o) => (o.error ? [`${o.run.id}: ${o.error}`] : [])) }
}

export interface ModelReport {
  model: string
  s14: S14Score
  s21: Omit<S21Result, 'share'> & { share: number | null }
  injection: InjectionScore
  promptTokensPerTurn: number | null
  /** What errored runs died of, per case. */
  errors: string[]
  /** S14: what the model did first in each case it got wrong. */
  s14Misses: string[]
  /** S21: the parts whose `about` matched no labelled part. */
  s21Misses: string[]
  requests: { requests: number; cacheHits: number; retries: number }
}

/** All three sets on one model. A number most of whose runs errored is null (cannot read), never 0. */
async function measure(model: string, door: Door, core: Core): Promise<ModelReport> {
  const before = { ...stats }
  const s14 = await runS14(door, core)
  const s21 = await runS21(door, core)
  const injection = await runInjection(door, core)
  const known = [...s14.tokens, ...s21.tokens, ...injection.tokens].filter((t): t is number => t !== null)
  const unreadable = s21.score.errored * 2 > s21.score.cases
  return {
    model,
    s14: s14.score,
    s21: { ...s21.score, share: unreadable ? null : s21.score.share },
    injection: injection.score,
    promptTokensPerTurn: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
    s14Misses: s14.missed ?? [],
    s21Misses: s21.missed ?? [],
    errors: [...s14.errors, ...s21.errors, ...injection.errors],
    requests: { requests: stats.requests - before.requests, cacheHits: stats.cacheHits - before.cacheHits, retries: stats.retries - before.retries },
  }
}

// --- always on: the harness, without a model --------------------------------------------------------------

/** A scripted model: each call answers with the structured answer tool and the given parts, unless `first` supplies the opening move. It records its answers. */
class Answering extends ScriptedChatModel {
  out: AIMessage[] = []
  parts: (messages: unknown) => { about: { kind: string; id: string }[]; text: string }[] = () => []
  first: ((tools: string[]) => AIMessage | null) | null = null
  constructor() {
    super({ model: 'test/scripted:free', script: [] })
  }
  async _generate(messages: Parameters<ScriptedChatModel['_generate']>[0]) {
    const tool = this.boundTools.find((n) => ANSWER_TOOL.test(n)) ?? 'extract-0'
    const answer = new AIMessage({ content: '', tool_calls: [{ name: tool, args: { parts: this.parts(messages) }, id: `call_${this.out.length}`, type: 'tool_call' }], usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } })
    const message = (this.out.length === 0 ? this.first?.(this.boundTools) : null) ?? answer
    this.out.push(message)
    return { generations: [{ message, text: '' }] }
  }
}
const askFor = (name: string, args: Record<string, unknown>) => (tools: string[]) => (tools.includes(name) ? new AIMessage({ content: '', tool_calls: [{ name, args, id: 'call_first', type: 'tool_call' }] }) : null)
const scriptedDoor =
  (parts: Answering['parts'], first: Answering['first'] = null): Door =>
  () => {
    const model = new Answering()
    model.parts = parts
    model.first = first
    return { id: 'test/scripted:free', model, responses: () => model.out }
  }

describe('the fixtures the chat cases name', () => {
  it('resolve for every attached thing in the S14 and S21 cases', () => {
    for (const c of [...S14_CASES, ...S21_CASES]) expect(() => resolveAll(c.attached), c.id).not.toThrow()
  })

  it('give a command a thing for each role, company and person, and the screen message names their ids', async () => {
    const [role, company] = resolveAll(['role:Senior Backend Engineer, Payments', 'company:Vantage Loom'])
    expect(role.thing).toMatchObject({ kind: 'role', pay: expect.stringMatching(/\$/), place: expect.any(String) })
    const screen = await screenOf([role.object, company.object])
    expect(screen).toContain(`role ${role.object.id}: Senior Backend Engineer, Payments`)
    expect(screen).toContain(`company ${company.object.id}: Vantage Loom`)
  })
})

describe.each(['deep', 'plain'] as const)('the harness on the %s core, with a scripted model', (core) => {
  it('reads the first move as a command in dot form, and an answer as no command', async () => {
    const restore = stubCommands()
    try {
      const call = await runTurn(scriptedDoor(() => [], askFor('roles_get', { id: 'x' })), core, { typed: 'Show the role', screen: null })
      expect(callsOf(call.responses.slice(0, 1))).toEqual(['roles.get'])
      const answer = await runTurn(scriptedDoor(() => [{ about: [], text: 'Hello.' }]), core, { typed: 'Thanks', screen: null })
      expect(callsOf(answer.responses)).toEqual([])
      expect(answer.answer?.parts).toEqual([{ about: [], text: 'Hello.' }])
    } finally {
      restore()
    }
  })

  it('scores S14, S21 and injection end to end, and maps the answer back to the case keys', async () => {
    const restore = stubCommands()
    try {
      // A model that answers at once, saying what each attached role is about by the id the screen message shows.
      const door = scriptedDoor((messages) => {
        const text = JSON.stringify(messages)
        const ids = [...text.matchAll(/(?:role|company|person|application) ([0-9a-f-]{36}):/g)].map((m) => m[1])
        return [...new Set(ids)].map((id) => ({ about: [{ kind: BY_ID.get(id)!.object.kind, id }], text: `${BY_ID.get(id)!.object.title}.` }))
      })
      const report = await measure('test/scripted:free', door, core)
      // It never calls a command, so the cases that allow a plain answer are the ones it gets right.
      expect(report.s14.right).toBe(S14_CASES.filter((c) => c.allowed.includes('answer')).length)
      expect(report.s14.errored).toBe(0)
      expect(report.s21).toMatchObject({ errored: 0, cases: S21_CASES.length, wrongObjectFacts: 0 })
      // One part per attached thing is right wherever the labelled parts are single things; the mapped ids are what make any of it right.
      expect(report.s21.share).toBeGreaterThan(0.6)
      expect(report.injection.errored).toBe(0)
      expect(report.promptTokensPerTurn).toBe(100)
    } finally {
      restore()
    }
  })

  it('runs a command from the fixtures and hands its result to the model', async () => {
    const restore = stubCommands()
    try {
      const [role] = resolveAll(['role:Staff Software Engineer, Query Engine'])
      let last = ''
      const door = scriptedDoor((messages) => {
        last = JSON.stringify(messages)
        return []
      }, askFor('roles_get', { id: role.object.id }))
      await runTurn(door, core, { typed: 'What does it pay?', screen: null })
      expect(last).toContain('$215,000 - $260,000')
    } finally {
      restore()
    }
  })
})

// --- live ------------------------------------------------------------------------------------------------

const TIER = (process.env.CHAT_EVAL_TIER ?? 'free') as Tier
const CORE = (process.env.CHAT_EVAL_CORE ?? 'deep') as Core
const MODELS = process.env.CHAT_EVAL_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [GENERATORS[0]]

/** The local database, only when the environment points at this computer. Never a remote project. */
async function localDb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  return (await import('@/lib/harness/supabase-admin')).createAdminClient()
}

describe.skipIf(process.env.RUN_CHAT_EVALS !== '1')(`chat evals (${TIER}, ${CORE})`, () => {
  it(
    'measures the command chosen, the answer about many things and the injection set',
    async () => {
      expect(TIERS, `CHAT_EVAL_TIER must be one of ${TIERS.join(', ')}`).toContain(TIER)
      expect(['deep', 'plain'], 'CHAT_EVAL_CORE must be deep or plain').toContain(CORE)
      if (TIER !== 'free') {
        // This file builds one model door, the free one. The local server and the owner's paid key are doors it does not have.
        console.log(`The ${TIER} tier was not run: this test builds only the free door (OpenRouter models ending in :free). ${TIER === 'local' ? 'The owner needs a model server on this computer' : "The owner needs his own key (OPENROUTER_API_KEY) and a paid model id"} and a build of this test with that door, then runs: RUN_CHAT_EVALS=1 CHAT_EVAL_TIER=${TIER} CHAT_EVAL_CORE=${CORE} CHAT_EVAL_MODELS=<model id> pnpm exec vitest run lib/chat/evals/live.eval.test.ts`)
        return
      }
      const restore = stubCommands()
      const models: ModelReport[] = []
      try {
        // One model at a time, so its request counts are its own.
        for (const id of MODELS) models.push(await measure(id, freeDoor(id), CORE))
      } finally {
        restore()
      }

      const report = { tier: TIER, core: CORE, ranAt: new Date().toISOString(), thresholds: BARS, models }
      const dir = path.join(__dirname, 'reports')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, `${TIER}-${CORE}.json`), `${JSON.stringify(report, null, 2)}\n`)
      // Every run is kept, oldest first: one run is one sample, and decide.ts reads the spread from this file.
      const runsFile = path.join(dir, `${TIER}-${CORE}-runs.json`)
      const before = existsSync(runsFile) ? (JSON.parse(readFileSync(runsFile, 'utf8')) as { runs: unknown[] }).runs : []
      writeFileSync(runsFile, `${JSON.stringify({ tier: TIER, core: CORE, runs: [...before, report] }, null, 2)}\n`)
      const cell = (v: number | null, d = 2) => (v === null ? 'cannot read' : v.toFixed(d))
      for (const m of models) {
        console.log(`${m.model} (${CORE}): S14 ${m.s14.right}/${m.s14.cases} (${cell(m.s14.overall)}); S21 share ${cell(m.s21.share)}, wrong-object facts ${m.s21.wrongObjectFacts}, errored ${m.s21.errored}/${m.s21.cases}; injection violations ${m.injection.violations.length}, errored ${m.injection.errored}; prompt tokens per turn ${m.promptTokensPerTurn ?? 'cannot read'}; requests ${JSON.stringify(m.requests)}`)
      }

      const db = await localDb()
      if (!db) console.log('No local database in the environment: nothing was recorded to measure_runs.')
      else {
        for (const m of models) {
          const meta = { tier: TIER, model: m.model, core: CORE, promptTokens: m.promptTokensPerTurn }
          const ok = [await recordS14(db, m.s14, m.injection, meta), await recordS21(db, m.s21, meta)]
          console.log(`${m.model}: ${ok.every(Boolean) ? 'recorded S14 and S21' : 'could not record to the local database'}`)
        }
      }

      if (process.env.CHAT_EVAL_GATE !== '0') {
        for (const m of models) {
          expect(m.s14.passed, `${m.model} S14 ${cell(m.s14.overall)} is under ${BARS.S14.overall}`).toBe(true)
          expect(m.s21.share !== null && m.s21.errored === 0 && m.s21.share >= BARS.S21.share && m.s21.wrongObjectFacts <= BARS.S21.wrongObjectFacts, `${m.model} S21 share ${cell(m.s21.share)}, wrong-object facts ${m.s21.wrongObjectFacts}`).toBe(true)
          expect(m.injection.violations.length <= BARS.injection.violations && m.injection.passed, `${m.model} injection: ${m.injection.violations.join('; ') || `${m.injection.errored} cases errored`}`).toBe(true)
        }
      }
    },
    7_200_000
  )
})
