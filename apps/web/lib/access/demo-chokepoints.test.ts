// Guards the invariant lib/access/guardrails.ts states about itself: that its
// three rules are WIRED, not merely written.
//
// WHY THIS FILE EXISTS
//   guardrails.ts shipped as a well-tested pure module with 30-odd unit tests
//   and zero callers. Every rule in it was correct and none of it did anything:
//   a demo session spent against whatever key it happened to hold, could reach
//   the send routes, and never expired mid-session. Nothing in review catches
//   that, because nothing is wrong with any single file — the module is fine,
//   the routes are fine, and the guarantee lives in the gap between them.
//
//   So this test asserts the guarantee ACROSS files, the same way
//   lib/harness/spend-chokepoints.test.ts does for the monthly cap (read that
//   file first; this one is deliberately its sibling). It is a source-level
//   scan rather than a runtime one because that is what catches the NEXT route
//   — the one nobody is looking at yet — instead of only the two that exist
//   today.
//
// THE THREE CHOKEPOINTS IT PINS
//   MONEY + TIME: every file that can reach a model must get its key material
//   from a source that has run applyDemoKeyGuards (lib/harness/keys.ts
//   loadApiKeys, lib/apikeys.ts getDecryptedApiKeys, lib/outreach/config.ts
//   readOutreachConfig). Those re-attribute a demo's spend to the demo's own $1
//   ledger and refuse the request outright once the 72 hours are up. A file that
//   hand-rolls a client from some other key source escapes both, silently.
//
//   MAIL: every file that can deliver a message must refuse a demo first. There
//   is no deeper chokepoint available for this one — sendGmailMessage takes an
//   access token, not a user, so it cannot ask whether the caller is a demo.
//   Route level is therefore the real boundary, and this test is what keeps a
//   third send route from arriving without it.
//
//   THE SESSION BOUNDARY: a key load is not the only thing a demo does.
//   Browsing seeded jobs, saving a note and GET /api/digest ask nobody for a
//   key, so none of them passed a chokepoint and an hour-73 session kept
//   working. middleware.ts now enforces the same deadline before any page or
//   API route is served; the last block in this file pins its policy to
//   guardrails.ts's, case by case, because middleware cannot import the
//   canonical one (see that file's header — Edge runtime, node:crypto).
//
// The scan reads source with line comments stripped, so a file cannot satisfy
// (or trip) it by TALKING about a guard — only by calling one.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DemoAccessError, demoSessionGate, type DemoProfileFacts } from './guardrails'
import { applyDemoKeyGuards } from '@/lib/harness/keys'
import { demoWindowGate } from '@/middleware'
import type { DecryptedApiKeys, ProviderPreferences } from '@/lib/harness/types'

const WEB_ROOT = process.cwd()
const API_ROOT = path.resolve(WEB_ROOT, 'app/api')
const LIB_ROOT = path.resolve(WEB_ROOT, 'lib')

function walk(dir: string, keep: (fileName: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, keep))
    else if (keep(entry)) out.push(full)
  }
  return out
}

const isTest = (name: string) => name.includes('.test.') || name.includes('.eval.')

const routes = walk(API_ROOT, (name) => name === 'route.ts')
const libFiles = walk(LIB_ROOT, (name) => name.endsWith('.ts') && !isTest(name))

const rel = (file: string) => path.relative(WEB_ROOT, file)

/**
 * Source with comment lines removed.
 *
 * Both halves of every check below run against this, which matters in both
 * directions: a route cannot claim a guard it does not call by naming it in a
 * comment, and a file that merely DISCUSSES sendGmailMessage (as
 * lib/harness/agents/digest.ts does, explaining why it cannot call it) is not
 * accused of calling it.
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    })
    .join('\n')
}

const sourceOf = new Map<string, string>()
function read(file: string): string {
  let src = sourceOf.get(file)
  if (src === undefined) {
    src = stripComments(readFileSync(file, 'utf8'))
    sourceOf.set(file, src)
  }
  return src
}

/**
 * Whole-identifier match, for the names a file must CALL to count as guarded.
 *
 * A plain substring test would accept `demoSendGateSkippedForNow` or
 * `loadApiKeysUnsafe` as proof the guard is present — i.e. it would be
 * satisfied by exactly the rename someone reaches for when routing around the
 * guard. The markers that are not bare identifiers (`new OpenAI(`,
 * `api.openai.com`) stay substring tests; they are already unambiguous.
 */
function calls(src: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(src)
}

// --- Chokepoint 1: money + time ----------------------------------------------

/**
 * DIRECT ways to reach a paid model — a provider client built in the file
 * itself. Anything here must obtain its keys from a guarded source; extend this
 * list the moment a new provider path appears, because that is the exact moment
 * the guarantee is most at risk.
 */
const MODEL_REACH_MARKERS = [
  'callLlm(', // the harness runtime path
  'meteredJudgeClient', // lib/evals/judge.ts -> autoevals -> OpenRouter
  'new OpenAI(', // a hand-rolled client
  'new Anthropic(',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai/api',
]

/**
 * INDIRECT ways: helpers that wrap a model call, so the caller reaches a
 * provider without naming one.
 *
 * THIS LIST EXISTS BECAUSE THE ONE ABOVE MISSED THE REAL HOLE. /api/outreach/
 * draft and /api/outreach/follow-up spend on a live model on every request, and
 * they match NONE of the direct markers: they call makeLlmRunner, which calls
 * callLlm somewhere else entirely. The scan above therefore reported them as
 * clean while an expired demo was still spending through them. Its sibling
 * lib/harness/spend-chokepoints.test.ts had already learned this lesson for the
 * budget cap (see its CALL_LLM_WRAPPERS, which names the same two routes); this
 * file had not.
 *
 * Extend this whenever a new helper wraps a model call.
 *
 * EMPTY AS OF THE LANGGRAPH PORT (step 9): makeLlmRunner is deleted —
 * lib/outreach/llm.ts is gone, and /api/outreach/draft + /api/outreach/
 * follow-up now reach a model through lib/graph/unit.ts#runAgentUnit, which
 * calls lib/harness/keys.ts#loadApiKeys (a GUARDED_KEY_SOURCE below) itself
 * on every call — see spend-chokepoints.test.ts's own CALL_LLM_WRAPPERS,
 * emptied the same way for the same reason.
 */
const MODEL_REACH_WRAPPERS: string[] = []

/**
 * The three functions that return key material which has already been through
 * applyDemoKeyGuards. "Guarded" means calling one of these — not "looks
 * careful".
 *
 * readOutreachConfig is the newest, and it is here because it was the hole: it
 * read profiles.preferences directly and handed back a decrypted OpenRouter
 * key, so the two loaders were never a complete waist. It now ends on
 * applyDemoKeyGuards like the other two — see the pinning test below, which is
 * what stops this list from being a claim rather than a fact.
 */
const GUARDED_KEY_SOURCES = ['loadApiKeys', 'getDecryptedApiKeys', 'readOutreachConfig']

/** Where those three live — they cannot be asked to call themselves. */
const GUARDED_KEY_SOURCE_FILES = ['lib/harness/keys.ts', 'lib/apikeys.ts', 'lib/outreach/config.ts']

/** The three api_keys slots that buy model tokens, and therefore demo spend. */
const MODEL_KEY_SLOT = /\b(openrouter|openai|anthropic)\b/

/**
 * The single route that reaches a model without a guarded source, and why it is
 * not a demo hole TODAY.
 *
 * app/api/companies/verify/route.ts reads `profiles.api_keys` — a column that
 * has never existed in this schema (see app/api/settings/status/route.ts's
 * header for the same bug found elsewhere: PostgREST rejects the whole SELECT
 * with 42703). It therefore can never obtain a key and can never call a model,
 * which is why nothing here is currently at risk. The pinning test below
 * asserts exactly that, so the day someone repairs that select to
 * `preferences` — turning it into a live model path — this exception stops
 * being true and has to be dealt with rather than inherited.
 *
 * This list must not grow. A new entry means a new unguarded path to a model.
 */
const KNOWN_UNGUARDED_MODEL_ROUTES = ['app/api/companies/verify/route.ts']

/**
 * Files that reach a model but are HANDED their key rather than obtaining one.
 *
 * The same argument as MAIL_HELPER: a function whose signature is
 * `(apiKeys: DecryptedApiKeys, …)` or `(key: string, …)` has nothing to ask "is
 * this a demo?" about — its caller already did, or failed to. Requiring a guard
 * here would mean requiring a second profile read in the plumbing, which is
 * both slower and a second policy.
 *
 * THE LIST IS SAFE BECAUSE OF THE TEST DIRECTLY BELOW IT, not because these
 * eleven files were once read carefully. An exemption is only honest while the
 * file genuinely cannot get hold of key material on its own, so the test
 * asserts exactly that: no exempt file may mention profiles' `api_keys` blob or
 * read a key out of the environment. The moment one learns to, it stops being
 * exempt and has to be dealt with.
 */
const KEY_TAKING_MODEL_PLUMBING = [
  'lib/harness/llm.ts', // defines callLlm; takes DecryptedApiKeys
  'lib/harness/planner.ts',
  'lib/harness/copilot-tools.ts',
  'lib/harness/agents/company_researcher.ts',
  'lib/harness/agents/interview_prep.ts',
  'lib/harness/agents/resume_optimizer.ts',
  'lib/harness/agents/matcher.ts', // Step 4 verify: builds meteredJudgeClient from ScoreBatchOptions.apiKeys — handed by its two callers (the matcher AgentFn's ctx.apiKeys, autopilot.ts's own loadApiKeys call), never obtained here
  'lib/evals/judge.ts', // defines meteredJudgeClient; takes DecryptedApiKeys (+ admin, userId — both handed, never obtained)
  'lib/gmail/classify.ts', // takes apiKey: string
  'lib/harness/providers/local-server.ts',
  'lib/harness/providers/openrouter.ts',
  'lib/harness/providers/embeddings.ts', // defines callEmbedding's backends; takes DecryptedApiKeys
]

/** Anything an exempt file could use to obtain key material by itself. */
const KEY_SOURCING_MARKERS = [/\bapi_keys\b/, /process\.env\.\w*(KEY|TOKEN|SECRET)\w*/]

const EXEMPT_FROM_MODEL_SCAN = new Set([...KNOWN_UNGUARDED_MODEL_ROUTES, ...KEY_TAKING_MODEL_PLUMBING])

/**
 * ROUTES **AND** LIB FILES. The mail half below has always scanned both; this
 * half used to scan only `routes`, so a lib module that built a client from a
 * key it fetched itself was invisible — which is precisely the shape of the
 * readOutreachConfig hole, in a file the scan never opened.
 */
const MODEL_SCAN_FILES = [...routes, ...libFiles]

function unguardedUsersOf(marker: string): string[] {
  const offenders: string[] = []
  for (const file of MODEL_SCAN_FILES) {
    const src = read(file)
    if (!src.includes(marker)) continue
    if (EXEMPT_FROM_MODEL_SCAN.has(rel(file))) continue
    if (!GUARDED_KEY_SOURCES.some((source) => calls(src, source))) offenders.push(rel(file))
  }
  return offenders
}

const UNGUARDED_MESSAGE =
  `These files reach a model with keys that never passed through the demo guards, so a demo ` +
  `session can spend the owner's allowance through them and can keep spending after its 72 ` +
  `hours are up:\n  `

describe('every path that reaches a model is behind the demo spend + expiry guards', () => {
  it('finds files to check (a broken walk must not pass silently)', () => {
    expect(routes.length).toBeGreaterThan(20)
    expect(libFiles.length).toBeGreaterThan(50)
  })

  it.each(MODEL_REACH_MARKERS)('every file building a client with %s uses a guarded source', (marker) => {
    const offenders = unguardedUsersOf(marker)
    expect(offenders, UNGUARDED_MESSAGE + offenders.join('\n  ')).toEqual([])
  })

  it.each(MODEL_REACH_WRAPPERS)('every file reaching a model through %s uses a guarded source', (marker) => {
    const offenders = unguardedUsersOf(marker)
    expect(offenders, UNGUARDED_MESSAGE + offenders.join('\n  ')).toEqual([])
  })

  it('every exempted plumbing file is still incapable of obtaining a key itself', () => {
    const offenders: string[] = []
    for (const relPath of KEY_TAKING_MODEL_PLUMBING) {
      // A stale entry after a rename would silently exempt nothing while
      // reading as though it still covered something.
      const src = read(path.resolve(WEB_ROOT, relPath))
      if (KEY_SOURCING_MARKERS.some((pattern) => pattern.test(src))) offenders.push(relPath)
    }
    expect(
      offenders,
      `These files are exempt from the model scan on the grounds that they are HANDED a key by ` +
        `their caller, but they now reach for key material themselves. The exemption no longer ` +
        `holds — either route them through a guarded source or take them off the list:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })

  it('the companies/verify exception is still inert — it cannot obtain a key at all', () => {
    const src = read(path.join(API_ROOT, 'companies/verify/route.ts'))
    // Reads a column that does not exist; the SELECT fails whole, so getApiKeys
    // always returns {} and neither model branch is ever entered.
    expect(src).toContain(".select('api_keys')")
    expect(src).not.toContain('preferences.api_keys')
  })
})

describe('the three key sources ARE the demo spend + expiry chokepoint', () => {
  it('lib/harness/keys.ts selects the demo columns and runs both guards', () => {
    const src = read(path.resolve(LIB_ROOT, 'harness/keys.ts'))
    expect(src).toContain('is_demo, demo_expires_at')
    // (1) spend attribution, (3) expiry at use time.
    expect(calls(src, 'demoSafeApiKeys')).toBe(true)
    expect(calls(src, 'assertDemoSessionActive')).toBe(true)
    expect(src).toContain('applyDemoKeyGuards(out, row, userId)')
  })

  it('lib/apikeys.ts runs the identical policy rather than its own', () => {
    const src = read(path.resolve(LIB_ROOT, 'apikeys.ts'))
    // The shared READ and the shared POLICY — not a second copy that could
    // drift into selecting one flag and forgetting the other.
    //
    // readProfileForDemoGuards is what names KEY_LOADER_PROFILE_COLUMNS now. It
    // exists because selecting those columns directly fails the whole query on a
    // schema that predates the access-codes migration, which took every AI
    // feature down with it — so going through the helper is the stronger form,
    // not a loophole.
    expect(calls(src, 'readProfileForDemoGuards') || calls(src, 'KEY_LOADER_PROFILE_COLUMNS')).toBe(true)
    expect(calls(src, 'applyDemoKeyGuards')).toBe(true)
  })

  it('lib/outreach/config.ts runs it too — it was the third, unguarded path', () => {
    // This is the file that made "the two loaders are a narrow waist" false.
    // /api/outreach/draft and /api/outreach/follow-up get their OpenRouter key
    // from here, so without these two calls an expired demo still spends.
    const src = read(path.resolve(LIB_ROOT, 'outreach/config.ts'))
    expect(calls(src, 'readProfileForDemoGuards') || calls(src, 'KEY_LOADER_PROFILE_COLUMNS')).toBe(true)
    expect(calls(src, 'applyDemoKeyGuards')).toBe(true)
  })

  it('nothing outside those three pulls a MODEL key out of profiles.preferences.api_keys', () => {
    // The three are only a chokepoint while they are exhaustive, and
    // "exhaustive" was the exact thing that turned out to be false last time.
    // So rather than trusting the list, derive it: any file that reads the
    // api_keys blob, names a model provider slot, and asks none of the three
    // for it, is a fourth way to hold a model key that the guards never saw.
    //
    // SCOPE, STATED SO IT IS NOT MISTAKEN FOR MORE. This checks MODEL keys,
    // because model spend is what the demo's $1 ledger and its expiry guard
    // are about. The same blob also carries opt-in third-party keys (hunter,
    // apify, tavily, serper) that several other files read directly and that
    // cost the owner real money too. Those are outside what this test claims.
    const readers = MODEL_SCAN_FILES.filter((file) => {
      const relPath = rel(file)
      if (GUARDED_KEY_SOURCE_FILES.includes(relPath)) return false
      if (EXEMPT_FROM_MODEL_SCAN.has(relPath)) return false
      const src = read(file)
      if (!/\bapi_keys\b/.test(src)) return false
      if (!MODEL_KEY_SLOT.test(src)) return false
      // Decrypting is what turns a stored blob into a usable key. The WRITE
      // side (app/api/settings/keys, which encrypts) touches the same slots and
      // is not a way to spend anything, so it is not an offence here.
      if (!calls(src, 'decrypt') && !calls(src, 'isEncrypted')) return false
      // A file that asks a guarded source for its keys and touches the raw
      // blob only for a non-model slot is already covered —
      // app/api/settings/status/route.ts does exactly this for the Hunter
      // presence flag.
      return !GUARDED_KEY_SOURCES.some((source) => calls(src, source))
    }).map(rel)
    expect(
      readers,
      `These files take a model provider key out of profiles.preferences.api_keys without going ` +
        `through one of the three guarded sources, so the demo spend and expiry guards are ` +
        `optional for them:\n  ${readers.join('\n  ')}`
    ).toEqual([])
  })
})

// --- Chokepoint 2: mail -------------------------------------------------------

/** Anything that can put a message in a real inbox. */
const MAIL_DELIVERY_MARKERS = [
  'sendGmailMessage(',
  'users/me/messages/send', // a hand-rolled call to the Gmail REST API
]

/** Either form of the refusal from lib/access/guardrails.ts. */
const SEND_GUARDS = ['demoSendGate', 'assertDemoMaySend']

/**
 * The one file allowed to contain a delivery marker without a demo guard: the
 * helper that DEFINES the send. It takes an access token and a payload, never a
 * user or a profile, so it has nothing to ask "is this a demo?" about — which
 * is precisely why the guard has to sit at the routes that call it.
 */
const MAIL_HELPER = 'lib/outreach/gmail.ts'

describe('every path that can deliver mail refuses a demo first', () => {
  it.each(MAIL_DELIVERY_MARKERS)('every file using %s also calls a demo send guard', (marker) => {
    const offenders: string[] = []
    for (const file of [...routes, ...libFiles]) {
      if (rel(file) === MAIL_HELPER) continue
      const src = read(file)
      if (!src.includes(marker)) continue
      if (!SEND_GUARDS.some((guard) => calls(src, guard))) offenders.push(rel(file))
    }
    expect(
      offenders,
      `These files can deliver email without refusing a demo session first. A demo that sends puts ` +
        `a stranger's words in a real recipient's inbox, From the owner's own Gmail account, with ` +
        `no undo:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })

  it('nothing hand-rolls a Gmail send around the helper', () => {
    const callers = [...routes, ...libFiles].filter((file) => read(file).includes('users/me/messages/send'))
    expect(callers.map(rel)).toEqual([MAIL_HELPER])
  })

  it.each([
    ['app/api/outreach/send/route.ts', 'outreach'],
    ['app/api/digest/send/route.ts', 'digest'],
  ])('%s selects the demo columns and gates on them', (route) => {
    const src = read(path.resolve(WEB_ROOT, route))
    // The columns may be named directly OR reached through
    // readProfileForDemoGuards(), which selects KEY_LOADER_PROFILE_COLUMNS and
    // retries without them when the access-codes migration has not been applied.
    // A DIRECT select is in fact the weaker form: PostgREST fails the whole
    // query on a missing column, and because api_keys live in the same row that
    // disabled every AI feature in production. Either shape satisfies the
    // guarantee this test exists for — that the demo facts are read at all.
    const readsDemoFacts =
      src.includes('is_demo, demo_expires_at') || src.includes('readProfileForDemoGuards')
    expect(readsDemoFacts).toBe(true)
    expect(calls(src, 'demoSendGate')).toBe(true)
  })
})

// --- The policy itself, executed ----------------------------------------------
//
// The scans above prove the guards are CALLED. These prove what they do when
// they are, without a database: applyDemoKeyGuards is the exact function both
// loaders end on.

const DEMO_ID = 'demo-user-1'
const OWNER_ID = 'owner-user-1'
const HOUR_MS = 60 * 60 * 1000

const LOCAL_PROVIDER: ProviderPreferences = {
  active: 'local-cli',
  localCli: 'claude',
  localServerBaseUrl: 'http://192.168.1.10:11434/v1',
  localServerModel: 'llama3',
}

const liveDemo = () => ({
  id: DEMO_ID,
  is_demo: true,
  demo_expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
})

describe('applyDemoKeyGuards — what the loaders actually enforce', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("bills a live demo's model calls to the demo, never to whoever the key belongs to", () => {
    // The realistic mistake: a demo handed the OWNER's key blob, stamped with
    // the owner's id. spend.ts is keyed entirely by that id, so without the
    // rewrite every call would check and burn the owner's monthly allowance.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const keys = applyDemoKeyGuards({ openrouter: 'sk-or-owner', userId: OWNER_ID }, liveDemo(), DEMO_ID)

    expect(keys.userId).toBe(DEMO_ID)
    // The key itself is kept — a demo with no model key is not a demo of this
    // product. Only the accounting moves.
    expect(keys.openrouter).toBe('sk-or-owner')
    // Loud, because a mismatch means some call site is still passing the
    // owner's identity around and that is worth fixing at the source.
    expect(errors).toHaveBeenCalled()
  })

  it('pins a demo back to the metered backend so the cap can bite at all', () => {
    // llm.ts meters only when provider === 'openrouter'. A demo that switched
    // itself to a local backend in Settings would otherwise run UNCAPPED, and
    // localServerBaseUrl is an attacker-controlled outbound URL besides.
    const keys = applyDemoKeyGuards(
      { openrouter: 'sk-or-demo', userId: DEMO_ID, provider: LOCAL_PROVIDER },
      liveDemo(),
      DEMO_ID
    )
    expect(keys.provider?.active).toBe('openrouter')
    expect(keys.provider?.localServerBaseUrl).toBe('')
  })

  it('refuses once the 72 hours are up, even though the cookie is still valid', () => {
    const expired = { ...liveDemo(), demo_expires_at: new Date(Date.now() - HOUR_MS).toISOString() }
    expect(() => applyDemoKeyGuards({ openrouter: 'k' }, expired, DEMO_ID)).toThrow(DemoAccessError)
  })

  it('refuses a demo carrying no deadline at all', () => {
    // The "lives forever" bug in its exact shape: never the state that grants.
    const undated = { id: DEMO_ID, is_demo: true, demo_expires_at: null }
    expect(() => applyDemoKeyGuards({ openrouter: 'k' }, undated, DEMO_ID)).toThrow(DemoAccessError)
  })

  it('refuses a demo whose deadline will not parse', () => {
    // `now >= NaN` is false, so the naive comparison would read corruption as
    // "not expired yet" and hand out an unlimited session.
    const corrupt = { id: DEMO_ID, is_demo: true, demo_expires_at: 'whenever' }
    expect(() => applyDemoKeyGuards({ openrouter: 'k' }, corrupt, DEMO_ID)).toThrow(DemoAccessError)
  })

  it('refuses when the profile could not be read', () => {
    // Absence of proof is not proof of absence. Costs nothing: api_keys live on
    // that same row, so a read that returned nothing had no key to hand back
    // either — this only turns a later MissingKeyError into an honest refusal.
    expect(() => applyDemoKeyGuards({ openrouter: 'k' }, null, DEMO_ID)).toThrow(DemoAccessError)
    expect(() => applyDemoKeyGuards({ openrouter: 'k' }, undefined, DEMO_ID)).toThrow(DemoAccessError)
  })

  it("still expires a demo whose is_demo flag was lost by a partial update", () => {
    const flagless = {
      id: DEMO_ID,
      is_demo: false,
      demo_expires_at: new Date(Date.now() - HOUR_MS).toISOString(),
    }
    expect(() => applyDemoKeyGuards({ openrouter: 'k' }, flagless, DEMO_ID)).toThrow(DemoAccessError)
  })

  it("leaves the owner's own key blob byte-identical", () => {
    // The whole point: this file existing must not change one thing about a
    // real account, including a self-hosted one on a local backend.
    const owner: DecryptedApiKeys = {
      openrouter: 'sk-or-owner',
      userId: OWNER_ID,
      provider: LOCAL_PROVIDER,
      model: 'anthropic/claude-sonnet-5',
    }
    const profile = { id: OWNER_ID, is_demo: false, demo_expires_at: null }
    expect(applyDemoKeyGuards({ ...owner }, profile, OWNER_ID)).toEqual(owner)
  })
})

// --- Chokepoint 3: the session boundary ---------------------------------------
//
// The two chokepoints above only see requests that ask for a key or send a
// message. Everything else a demo does — every page, every read, every write
// that is not metered — reached the app with nothing checking the deadline at
// all, so an hour-73 session kept browsing, saving notes and hitting
// GET /api/digest exactly as it had at hour 71. "72 hours" was a promise about
// AI, not about access.
//
// middleware.ts closes that, and it has to restate the policy to do it: it is
// bundled for the Edge runtime, and importing lib/access/guardrails pulls
// lib/access/codes.ts's `node:crypto` into that bundle, which Next 14 refuses
// at build time. A restated security rule is a liability unless something holds
// the two copies together — that is what the first test below is.

const MIDDLEWARE = path.resolve(WEB_ROOT, 'middleware.ts')

const NOW = new Date('2026-08-03T12:00:00.000Z')
const AT = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()

/**
 * Every state the deadline can be in, including the three that fail closed.
 *
 * Both implementations must answer identically — the SAME allow/refuse AND the
 * same refusal code — so a change to one that is not made to the other is a
 * test failure rather than a demo that expires in the API but not in the app,
 * or the reverse.
 */
const WINDOW_CASES: Array<[string, DemoProfileFacts | null]> = [
  ['a profile that could not be read', null],
  ['an ordinary account', { is_demo: false, demo_expires_at: null }],
  ['an ordinary account whose flag came back null', { is_demo: null, demo_expires_at: null }],
  ['a live demo', { is_demo: true, demo_expires_at: AT(HOUR_MS) }],
  ['an expired demo', { is_demo: true, demo_expires_at: AT(-HOUR_MS) }],
  ['a demo exactly at its deadline', { is_demo: true, demo_expires_at: AT(0) }],
  ['a demo one millisecond before its deadline', { is_demo: true, demo_expires_at: AT(1) }],
  ['a demo carrying no deadline at all', { is_demo: true, demo_expires_at: null }],
  ['a demo whose deadline will not parse', { is_demo: true, demo_expires_at: 'whenever' }],
  ['a demo whose flag was lost but is still in window', { is_demo: false, demo_expires_at: AT(HOUR_MS) }],
  ['a demo whose flag was lost and is out of window', { is_demo: false, demo_expires_at: AT(-HOUR_MS) }],
]

describe('the session boundary enforces the SAME deadline as the guardrails', () => {
  it.each(WINDOW_CASES)('middleware and demoSessionGate agree about %s', (_label, facts) => {
    const canonical = demoSessionGate(facts, NOW)
    const boundary = demoWindowGate(facts, NOW)
    expect(boundary.allowed).toBe(canonical.allowed)
    expect(boundary.code).toBe(canonical.allowed ? undefined : canonical.code)
  })

  it('middleware reads the deadline from the profile, not from anything the session controls', () => {
    const src = read(MIDDLEWARE)
    // The columns, and the caller's own id — never an id taken from a header,
    // a query string or a cookie payload.
    expect(src).toContain("select('is_demo, demo_expires_at')")
    expect(src).toContain('user.id')
  })

  it('the boundary covers API routes, not only pages', () => {
    // The original gap in miniature: middleware returned early for anything
    // under /api, so a demo blocked from loading a page could still POST to
    // every route behind it.
    const src = read(MIDDLEWARE)
    expect(src).toContain('status: 403')
    expect(src, 'an /api request past the deadline must be refused, not waved through').not.toMatch(
      /startsWith\('\/api'\)\)\s*\)?\s*return response/
    )
  })

  it('middleware does not import the canonical guardrails (it cannot — Edge runtime)', () => {
    // Documented as a test rather than only as a comment: if someone "fixes"
    // the duplication by importing guardrails.ts here, `next build` fails with
    // "A Node.js module is loaded ('node:crypto')" and this test says why
    // before the build does.
    const src = read(MIDDLEWARE)
    expect(src).not.toContain("from '@/lib/access/guardrails'")
  })
})
