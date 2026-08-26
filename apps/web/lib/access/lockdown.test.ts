// Guards the invariants of supabase/migrations/20260803000003_demo_profile_lockdown.sql.
//
// WHY THIS FILE EXISTS
//   That migration is the backstop the whole access-code feature rests on. A
//   demo session is a REAL authenticated user on its own profiles row, holding
//   the browser's own anon key — so it has a direct PostgREST write path to
//   that row that no route handler is on, and `using (auth.uid() = id)` puts no
//   constraint on WHICH COLUMNS it may write. Every application-layer guardrail
//   in lib/access/guardrails.ts reads flags that live in that row. The trigger
//   is what makes those flags unwritable.
//
//   None of it can be unit tested the way the rest of lib/access is, because
//   the guarantee is enforced by Postgres and there is no database in this test
//   run. What CAN be tested — and is the failure mode that actually happens —
//   is the migration DRIFTING: someone adds a preference key and forgets the
//   guard, someone "simplifies" a raise into a silent return, someone widens
//   the service-role exemption, someone drops SECURITY INVOKER and thereby
//   turns every caller into the function's owner. Each of those leaves the file
//   looking healthy and the lockdown doing nothing.
//
//   So this is a SOURCE-LEVEL test over the .sql, in the same spirit as
//   lib/harness/spend-chokepoints.test.ts: it asserts properties across the
//   file that no single statement is responsible for.
//
// WHAT IS NOT COVERED HERE, and where it was covered instead
//   Runtime behaviour — that each guard actually refuses, that the owner's own
//   updates are untouched, that the service key can still do everything
//   redemption needs — was verified by executing this migration against a real
//   PostgreSQL 16 with a Supabase-shaped scaffold (anon/authenticated/
//   service_role/authenticator roles with authenticator a member of the other
//   three, RLS, auth.uid(), the profiles_updated_at trigger, and auth.role()
//   deliberately ABSENT so the migration's independence from it is proven
//   rather than asserted). 50 cases, all passing. Re-run that before changing
//   the SQL; do not treat a green run of THIS file as proof the trigger works.
//
// EVERY ASSERTION BELOW MUST FAIL WHEN THE PROPERTY IT NAMES IS REMOVED.
//   That is not a stylistic preference, it is the lesson this file has already
//   been taught. Two of its assertions used to check the security mode of a
//   function by searching the function's BODY for `security definer` — but the
//   body slice starts at `as $$`, and the mode is declared in the HEADER, so
//   the check was vacuous; the companion regex used an unbounded `[\s\S]*?`
//   that simply ran past the mutated header and matched a LATER function's
//   `security invoker`. Flipping is_service_role_request() to `security
//   definer` left all 39 tests green, while against a real Postgres that same
//   flip makes is_service_role_request() return TRUE instead of false for
//   every caller with no JWT claims — the lockdown off, silently. A security
//   test that passes when the security property is removed is worse than no
//   test, because it is also a claim that someone checked.
//
//   So: after editing this file, mutate the migration (flip a `security
//   invoker`, delete a guard, point a guard at a different key) and confirm
//   the corresponding test goes RED before trusting it.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file rather than process.cwd(): the migration lives at the
// repo root, two packages up, and the test must not depend on which directory
// vitest happened to be started from.
const MIGRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260803000003_demo_profile_lockdown.sql'
)

const SQL = readFileSync(MIGRATION_PATH, 'utf8')

/** Body of one `create or replace function public.<name>() ... $$;` block. */
function functionBody(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}()`)
  expect(start, `${name}() is not defined in the migration`).toBeGreaterThan(-1)
  const open = SQL.indexOf('as $$', start)
  const close = SQL.indexOf('$$;', open)
  expect(close, `${name}() has an unterminated body`).toBeGreaterThan(open)
  return SQL.slice(open, close)
}

/** Source with every `--` comment line removed, so prose never satisfies a test. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

/**
 * The HEADER of a function definition: everything between the signature and the
 * `as $$` that opens the body, comments removed.
 *
 * THIS IS WHERE `security invoker` / `security definer` LIVES. functionBody()
 * slices from `as $$` onward and therefore can NEVER contain the security mode
 * — which is exactly how the old assertions managed to be vacuous. Comments are
 * stripped because the migration's headers discuss the mode in prose ("NOT
 * security definer. See is_service_role_request() above…"), and prose must
 * never decide a test either way.
 */
function functionHeader(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}()`)
  expect(start, `${name}() is not defined in the migration`).toBeGreaterThan(-1)
  const open = SQL.indexOf('as $$', start)
  expect(open, `${name}() has no body, so it has no header either`).toBeGreaterThan(start)
  return stripComments(SQL.slice(start, open))
}

/**
 * Assert a function declares its security mode EXACTLY ONCE, in its header, and
 * that the mode is `want`.
 *
 * Both halves are load-bearing. Asserting only the positive would pass a header
 * that declared both modes; asserting only the negative would pass a header
 * that declared neither. Postgres defaults to INVOKER when the clause is
 * omitted, but silence is not a decision in a file whose whole boundary rests
 * on this distinction — and an omitted clause is indistinguishable from a
 * deleted one.
 */
function expectSecurityMode(name: string, want: 'invoker' | 'definer'): void {
  const declared = (functionHeader(name).match(/security\s+(invoker|definer)/g) ?? []).map((m) =>
    m.replace(/\s+/g, ' ')
  )
  expect(
    declared,
    `${name}() must declare \`security ${want}\` exactly once in its header`
  ).toEqual([`security ${want}`])
}

const LOCKDOWN = functionBody('enforce_demo_profile_lockdown')
const LOCKDOWN_CODE = stripComments(LOCKDOWN)
const EXEMPTION_CODE = stripComments(functionBody('is_service_role_request'))
const CODE_ISSUE_CODE = stripComments(functionBody('forbid_demo_access_code_issue'))

/**
 * Every privilege-bearing thing a demo profile must not be able to change, and
 * the refusal that proves it is guarded.
 *
 * `reads` lists the exact expressions the guard must evaluate — asserted so a
 * guard cannot be "kept" while being quietly pointed at a different key. It is
 * a LIST because one refusal may legitimately cover several keys that the
 * application reads as a single OR (see the top-level auto-submit row).
 *
 * ADDING A ROW HERE IS HOW YOU ADD A GUARD. If the app starts reading a new
 * preference that lets a demo spend more, send mail, extend its life or reach
 * the owner's data, it belongs in this list and in the migration.
 */
const GUARDED = [
  {
    what: 'is_demo — the flag every other guardrail reads',
    reads: ['new.is_demo'],
    refusal: 'demo profiles cannot change is_demo',
  },
  {
    what: 'demo_expires_at — the 72-hour promise, enforced at use time',
    reads: ['new.demo_expires_at is distinct from old.demo_expires_at'],
    refusal: 'demo profiles cannot change demo_expires_at',
  },
  {
    what: 'email — redemption recovers a workspace by looking a profile up by it',
    reads: ['new.email is distinct from old.email'],
    refusal: 'demo profiles cannot change email',
  },
  {
    what: 'budget.monthlyUsd raised — a one-request bypass of the $1 cap',
    reads: ["'{budget,monthlyUsd}'"],
    refusal: 'demo profiles cannot raise their AI budget cap',
  },
  {
    // spend.ts reads an absent/non-numeric cap as DEFAULT_MONTHLY_USD ($10), so
    // deleting the key is a 10x RAISE, not a reset. A guard that only compared
    // numbers would wave this through.
    what: 'budget.monthlyUsd removed — silently promotes the demo to the $10 default',
    reads: ["jsonb_typeof(new.preferences #> '{budget,monthlyUsd}')"],
    refusal: 'demo profiles cannot remove their AI budget cap',
  },
  {
    // Unreachable for a provisioned demo (which always carries monthlyUsd = 1)
    // and therefore easy to delete as dead code — but it is the branch that
    // stops a demo whose provisioning half-failed from writing its own ceiling
    // onto a row whose effective cap was the product default.
    what: 'budget.monthlyUsd introduced onto a row that had none',
    reads: ['elsif new_cap is not null then'],
    refusal: 'demo profiles cannot introduce an AI budget cap',
  },
  {
    what: 'budget.spentUsd lowered — refills the allowance the cap bounds',
    reads: ["'{budget,spentUsd}'"],
    refusal: 'demo profiles cannot reset their AI spend ledger',
  },
  {
    what: 'budget.periodStart moved — readState() zeroes the ledger on a new period',
    reads: ["'{budget,periodStart}'"],
    refusal: 'demo profiles cannot change their AI billing period',
  },
  {
    what: 'api_keys — swapping in key material of the demo holder’s own',
    reads: ["(new.preferences -> 'api_keys') is distinct from (old.preferences -> 'api_keys')"],
    refusal: 'demo profiles cannot change API keys',
  },
  {
    what: 'provider — a non-openrouter provider is NOT metered, so it runs uncapped',
    reads: ["(new.preferences -> 'provider') is distinct from (old.preferences -> 'provider')"],
    refusal: 'demo profiles cannot change the model provider',
  },
  {
    what: 'gmail_permissions — granting itself send/read scopes',
    reads: ["(new.preferences -> 'gmail_permissions') is distinct from (old.preferences -> 'gmail_permissions')"],
    refusal: 'demo profiles cannot change Gmail permissions',
  },
  {
    // parseGmailPermissions() INFERS an enabled `monitor` grant from gmail_sync
    // history whenever no gmail_permissions block is stored. Guarding only
    // gmail_permissions would leave that back door open on a row that never got
    // one.
    what: 'gmail_sync — the legacy back door to an inferred `monitor` grant',
    reads: ["(new.preferences -> 'gmail_sync') is distinct from (old.preferences -> 'gmail_sync')"],
    refusal: 'demo profiles cannot change Gmail sync state',
  },
  {
    what: 'outreach.autoSend — arming delivery',
    reads: ["'{outreach,autoSend}'"],
    refusal: 'demo profiles cannot enable auto-send',
  },
  {
    what: 'autopilot.autoSubmit — arming application submission',
    reads: ["'{autopilot,autoSubmit}'"],
    refusal: 'demo profiles cannot enable auto-submit',
  },
  {
    // A SECOND, DIFFERENT LOCATION for the same idea, and the one that was
    // actually reachable while the nested guard above was not.
    // app/(app)/queue/page.tsx reads
    //     autoSubmit: p.autoSubmit === true || p.autoApply === true
    // off the ROOT of preferences, not out of the `autopilot` block. Both
    // spellings are one guard because they are one OR in one expression.
    //
    // Nothing submits today (AUTO_SUBMIT_AVAILABLE is false and
    // lib/graph/autopilot.ts hardcodes its own `const autoSubmit = false`),
    // so the worst this key can currently do is make the queue banner tell a
    // demo that applications are going out when they are not. Guarded anyway:
    // "already refused elsewhere" is the exact argument that was true of
    // is_demo, and the day this key starts meaning something must not also be
    // the day a demo can set it.
    what: 'top-level autoSubmit / autoApply — the queue page reads BOTH, off the root',
    reads: ["'{autoSubmit}'", "'{autoApply}'"],
    refusal: 'demo profiles cannot enable top-level auto-submit',
  },
] as const

describe('the demo lockdown migration', () => {
  it('is the file this test thinks it is', () => {
    // A broken path would make every assertion below vacuous.
    expect(SQL.length).toBeGreaterThan(2000)
    expect(SQL).toContain('create trigger enforce_demo_profile_lockdown')
  })

  describe('the service-role exemption — the whole security boundary', () => {
    it('exists, and the lockdown routes through it rather than inlining a role test', () => {
      expect(LOCKDOWN_CODE).toContain('public.is_service_role_request()')
      expect(LOCKDOWN_CODE).toContain('return new;')
    })

    it('is decided by the VERIFIED TOKEN first, and only then by the database role', () => {
      // SET ROLE is authorised against session_user, and PostgREST's session
      // user (`authenticator`) IS a member of service_role — so current_user can
      // be flipped to service_role inside a request whose token still says
      // `authenticated`. The claim cannot be. Checking the role first would
      // reopen that; this ordering closes it, and it is the single most
      // load-bearing line in the file.
      const claimCheck = EXEMPTION_CODE.indexOf("claim_role = 'service_role'")
      const roleCheck = EXEMPTION_CODE.indexOf('current_user in (')
      expect(claimCheck, 'the JWT role claim must be consulted').toBeGreaterThan(-1)
      expect(roleCheck, 'current_user must be the fallback for non-request callers').toBeGreaterThan(-1)
      expect(
        claimCheck,
        'the verified token must decide BEFORE current_user, or a SET ROLE inside a demo request wins'
      ).toBeLessThan(roleCheck)
    })

    it('never trusts `authenticator`, `anon` or `authenticated` as server-side roles', () => {
      const allowlist = EXEMPTION_CODE.slice(EXEMPTION_CODE.indexOf('current_user in ('))
      for (const role of ['authenticator', 'anon', 'authenticated']) {
        expect(allowlist, `${role} must never be exempt from the lockdown`).not.toContain(`'${role}'`)
      }
    })

    it('does not depend on auth.role(), which Supabase deprecated and does not create everywhere', () => {
      // A missing function is not caught at apply time — plpgsql resolves
      // callees lazily — so it would surface as an error on EVERY profile
      // update, the owner's included. That is the worst outcome available here.
      expect(stripComments(SQL)).not.toContain('auth.role()')
    })

    it('cannot raise while deciding: the claims cast is wrapped in its own handler', () => {
      const cast = EXEMPTION_CODE.indexOf('::jsonb')
      const handler = EXEMPTION_CODE.indexOf('exception')
      expect(cast).toBeGreaterThan(-1)
      expect(handler, 'a malformed claims GUC must not break every profile UPDATE').toBeGreaterThan(cast)
      // missing_ok = true, so an unset GUC yields NULL instead of raising.
      expect(EXEMPTION_CODE).toContain("current_setting('request.jwt.claims', true)")
    })

    it('is SECURITY INVOKER, or current_user would be the owner and the lockdown would be off', () => {
      // MEASURED, not reasoned: applied to Postgres 16 with this one word
      // flipped to `definer`, is_service_role_request() answered TRUE instead
      // of false for a session running as `authenticated` with no JWT claims,
      // because current_user inside a definer context is the function's owner
      // (`postgres`) — which is in the fallback allowlist. Every guard below is
      // then skipped. Asserted on the HEADER; the old version of this test read
      // the BODY, where the clause cannot appear, and stayed green through
      // exactly this mutation.
      expectSecurityMode('is_service_role_request', 'invoker')
    })

    it('will not exempt on a forged claims GUC alone — the database role must agree', () => {
      // MEASURED: with the token branch reading `return claim_role =
      // 'service_role'` and nothing else, a session holding
      //     set local role authenticated
      //     set local request.jwt.claims = '{"role":"service_role"}'
      // got is_service_role_request() = TRUE and went on to run
      // `update profiles set is_demo = false` successfully.
      //
      // PostgREST never produces that pair — it derives the GUC and the SET
      // ROLE from the same verified token — so requiring them to agree costs
      // no legitimate caller anything (the service-key provisioning matrix
      // still passes) and means the GUC being unforgeable is no longer the
      // single assumption the exemption rests on.
      const at = EXEMPTION_CODE.indexOf("claim_role = 'service_role'")
      expect(at, 'the JWT role claim must be consulted').toBeGreaterThan(-1)
      const branch = EXEMPTION_CODE.slice(at, EXEMPTION_CODE.indexOf('end if;', at))
      expect(
        branch,
        'a service_role CLAIM must not be sufficient on its own'
      ).toContain('current_user not in (')
      for (const role of ['anon', 'authenticated', 'authenticator']) {
        expect(
          branch,
          `${role} must be refused the exemption even when the claims GUC says service_role`
        ).toContain(`'${role}'`)
      }
    })
  })

  describe('completeness — every privilege-bearing field has a guard', () => {
    it.each(GUARDED)('$what', ({ reads, refusal }) => {
      for (const expression of reads) {
        expect(
          LOCKDOWN_CODE,
          `the guard's own expression \`${expression}\` is missing, so the refusal below may be checking something else`
        ).toContain(expression)
      }
      expect(LOCKDOWN_CODE, `nothing refuses this`).toContain(refusal)
    })

    it('refuses by RAISING, never by returning — a silent return is an allowed write', () => {
      for (const { refusal } of GUARDED) {
        const at = LOCKDOWN_CODE.indexOf(refusal)
        const preceding = LOCKDOWN_CODE.slice(Math.max(0, at - 120), at)
        expect(preceding, `"${refusal}" must be the message of a raise`).toContain('raise exception')
      }
    })

    it('gives every refusal an errcode PostgREST turns into a 403, not a 500', () => {
      const raises = LOCKDOWN_CODE.match(/raise exception/g) ?? []
      const codes = LOCKDOWN_CODE.match(/errcode = 'insufficient_privilege'/g) ?? []
      expect(raises.length).toBe(GUARDED.length)
      expect(codes.length).toBe(raises.length)
    })

    it('has exactly the two documented early exits and one final allow', () => {
      // Three `return new` and no more: (1) not a demo, (2) server-side caller,
      // (3) every guard passed. A fourth would be a guard that decided to let
      // something through quietly.
      const returns = LOCKDOWN_CODE.match(/return new;/g) ?? []
      expect(
        returns.length,
        'an extra `return new` in this function is a guard that stopped guarding'
      ).toBe(3)
      expect(LOCKDOWN_CODE).not.toContain('return null')
    })

    it('checks "is this a demo?" BEFORE anything else, so the owner is untouched', () => {
      // For a normal profile (is_demo false, demo_expires_at null — every real
      // account, since is_demo is NOT NULL DEFAULT false) the whole body is two
      // comparisons and a return: no helper call, no jsonb parsing, no cast.
      // That is the proof that nothing here can break the owner's own writes.
      const demoCheck = LOCKDOWN_CODE.indexOf('old.demo_expires_at is null')
      const anythingElse = LOCKDOWN_CODE.indexOf('public.is_service_role_request()')
      expect(demoCheck).toBeGreaterThan(-1)
      expect(demoCheck).toBeLessThan(anythingElse)
    })

    it('treats a demo deadline as a demo signal, matching isDemoProfile()', () => {
      // guardrails.ts's isDemoProfile ORs the two signals; if the database
      // disagreed, a row whose flag was already dropped would fall out of the
      // lockdown entirely.
      expect(LOCKDOWN_CODE).toMatch(/coalesce\(old\.is_demo, false\) is not true and old\.demo_expires_at is null/)
    })
  })

  describe('no cast in this trigger can fail', () => {
    // A cast error inside a BEFORE UPDATE trigger is the worst outcome
    // available: it breaks the write for a reason nobody can act on. jsonb
    // guarantees that a value of type 'number' is a valid numeric literal, so
    // gating every ::numeric on jsonb_typeof makes failure impossible — while
    // `(preferences #>> path)::numeric` on "one dollar", an object or a boolean
    // raises invalid_text_representation.
    it('gates every numeric cast on jsonb_typeof(...) = \'number\'', () => {
      const casts = LOCKDOWN_CODE.match(/::numeric/g) ?? []
      const gates = LOCKDOWN_CODE.match(/jsonb_typeof\([^)]*\) = 'number'/g) ?? []
      expect(casts.length).toBeGreaterThan(0)
      expect(
        gates.length,
        'every ::numeric must sit behind a jsonb_typeof check, or a corrupt preference bricks the row'
      ).toBe(casts.length)
    })

    it('never casts a jsonb value to numeric outside a case guard', () => {
      for (const line of LOCKDOWN_CODE.split('\n')) {
        if (!line.includes('::numeric')) continue
        expect(line, `unguarded numeric cast: ${line.trim()}`).toMatch(/#>>/)
      }
    })
  })

  describe('the trigger itself', () => {
    it('is BEFORE UPDATE — `with check` cannot see OLD, so it cannot police a transition', () => {
      expect(SQL).toMatch(/create trigger enforce_demo_profile_lockdown\s+before update of /)
      expect(SQL).toContain('for each row')
    })

    it('lists every column the function reads in its `of (...)` clause', () => {
      // `update of` fires only when a listed column is in the SET list. That is
      // a blast-radius control (a resume_text-only write never enters the
      // function at all) and it cannot weaken the lockdown — a column absent
      // from SET cannot change. But a guarded column missing from the list
      // WOULD silently stop being guarded.
      const clauseStart = SQL.indexOf('before update of ')
      expect(clauseStart).toBeGreaterThan(-1)
      const clause = SQL.slice(clauseStart, SQL.indexOf('on public.profiles', clauseStart))
      const referenced = new Set(
        [...LOCKDOWN_CODE.matchAll(/\b(?:new|old)\.([a-z_]+)/g)].map((m) => m[1])
      )
      expect(referenced.size).toBeGreaterThan(2)
      for (const column of referenced) {
        expect(clause, `${column} is guarded but missing from the trigger's \`update of\` list`).toContain(
          column
        )
      }
    })

    it('is SECURITY INVOKER — a definer context would rewrite current_user to the owner', () => {
      // Header, not body: this function's header COMMENT contains the words
      // "NOT security definer", so a body-or-substring check here is doubly
      // untrustworthy. functionHeader() strips comments for that reason.
      expectSecurityMode('enforce_demo_profile_lockdown', 'invoker')
    })

    it('pins search_path on every function it defines', () => {
      const definitions = SQL.match(/create or replace function public\.\w+\(\)/g) ?? []
      const pins = SQL.match(/set search_path = ''/g) ?? []
      expect(definitions.length).toBeGreaterThan(2)
      expect(pins.length, 'a mutable search_path is how a SECURITY DEFINER gets hijacked').toBe(
        definitions.length
      )
    })
  })

  describe('demo-to-demo chaining is refused by the database too', () => {
    it('blocks a demo from inserting an access code', () => {
      expect(CODE_ISSUE_CODE).toContain('demo profiles cannot issue access codes')
      expect(CODE_ISSUE_CODE).toContain("errcode = 'insufficient_privilege'")
      expect(SQL).toMatch(/create trigger forbid_demo_access_code_issue\s+before insert on public\.access_codes/)
    })

    it('reads the profile with definer rights, so an invisible row cannot look like "not a demo"', () => {
      // The opposite of the lockdown's choice, and deliberately: this one has to
      // read a row the caller may not be able to SELECT under RLS. With invoker
      // rights the `exists` would return false for an unreadable profile and the
      // guard would fail OPEN.
      // The one function in this file that is deliberately DEFINER. Asserted on
      // the header for the same reason as the two above — and the mode must be
      // stated exactly once, because an omitted clause silently means INVOKER
      // and would make this guard fail OPEN.
      expectSecurityMode('forbid_demo_access_code_issue', 'definer')
      expect(CODE_ISSUE_CODE).toContain('public.profiles')
    })

    it('has no service-role exemption — nothing server-side issues a code for a demo', () => {
      expect(CODE_ISSUE_CODE).not.toContain('is_service_role_request')
    })
  })

  describe('safe to apply, and safe to apply again', () => {
    it('creates every object idempotently', () => {
      expect(SQL).toContain('create index if not exists')
      expect((SQL.match(/create or replace function/g) ?? []).length).toBeGreaterThanOrEqual(3)
      const triggers = SQL.match(/create trigger/g) ?? []
      const drops = SQL.match(/drop trigger if exists/g) ?? []
      expect(drops.length, 'each trigger needs its own drop-if-exists to be re-runnable').toBe(
        triggers.length
      )
    })

    it('contains no destructive statement — the only `drop` is the idempotency guard', () => {
      // This migration must never be a way to lose data or quietly remove a
      // policy. `drop trigger if exists` immediately followed by `create
      // trigger` is the one permitted form.
      for (const [, dropped] of SQL.matchAll(/\bdrop\s+(\w+)/gi)) {
        expect(dropped.toLowerCase(), `unexpected \`drop ${dropped}\` in a security migration`).toBe(
          'trigger'
        )
      }
      for (const forbidden of [
        'delete from',
        'truncate',
        'alter policy',
        'drop policy',
        'disable row level security',
        'disable trigger',
      ]) {
        expect(stripComments(SQL).toLowerCase()).not.toContain(forbidden)
      }
    })

    it('refuses to apply before the migration that adds the columns it guards', () => {
      // plpgsql resolves column references on first FIRE, not at apply time, so
      // without this precondition a missing `is_demo` would turn into a runtime
      // error on every profile UPDATE instead of a migration that did not run.
      expect(SQL).toContain("to_regclass('public.access_codes') is null")
      expect(SQL).toContain('apply 20260803000002_access_codes.sql before this migration')
      expect(SQL).toMatch(/perform p\.is_demo[\s\S]*?from public\.profiles p\s+where false;/)
    })

    it('proves both triggers are attached before it finishes', () => {
      // "Applied but not attached" looks exactly like success otherwise, and
      // this is the one control the rest of the feature rests on.
      expect(SQL).toContain("tgname = 'enforce_demo_profile_lockdown'")
      expect(SQL).toContain("tgname = 'forbid_demo_access_code_issue'")
      expect(SQL).toContain('is not attached to public.profiles')
    })
  })
})

// ---------------------------------------------------------------------------
// graph_threads: 20260817000003_graph_threads_demo_lockdown.sql
// ---------------------------------------------------------------------------
// Guards a SECOND, capability-bearing table added by the LangGraph port
// (binding ruling 5, class 1: same treatment as api_tokens and
// apply_phase_tokens — RLS + trigger deny + route refusal — because a
// thread_id is a bare capability with no ownership check of its own inside
// the checkpointer). Same source-level-scan approach as the profiles
// lockdown above, and the same warning applies: this proves the SQL TEXT has
// the shape it claims to have, not that Postgres enforces it at runtime.
//
// MUTATION-TESTED BY HAND: with the `raise exception` in
// forbid_demo_graph_threads() commented out (an in-memory copy of the
// migration text, restored immediately after), every assertion in
// 'the deny fires by raising, not returning' below went red — the regex for
// `raise exception` inside the function body no longer matched, and
// `functionBody()`/`expectSecurityMode()` calls that depend on the function
// existing at all still passed, isolating the mutation to exactly the
// assertion meant to catch it. The migration file itself was restored
// unchanged before this test file was finalized.

const GRAPH_THREADS_LOCKDOWN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260817000003_graph_threads_demo_lockdown.sql'
)

const GRAPH_THREADS_SQL = readFileSync(GRAPH_THREADS_LOCKDOWN_PATH, 'utf8')

/** Same extraction as functionBody()/functionHeader() above, generalized over which SQL string to scan. */
function functionBodyIn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}()`)
  expect(start, `${name}() is not defined in the migration`).toBeGreaterThan(-1)
  const open = sql.indexOf('as $$', start)
  const close = sql.indexOf('$$;', open)
  expect(close, `${name}() has an unterminated body`).toBeGreaterThan(open)
  return sql.slice(open, close)
}

function functionHeaderIn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}()`)
  expect(start, `${name}() is not defined in the migration`).toBeGreaterThan(-1)
  const open = sql.indexOf('as $$', start)
  expect(open, `${name}() has no body, so it has no header either`).toBeGreaterThan(start)
  return stripComments(sql.slice(start, open))
}

function expectSecurityModeIn(sql: string, name: string, want: 'invoker' | 'definer'): void {
  const declared = (functionHeaderIn(sql, name).match(/security\s+(invoker|definer)/g) ?? []).map((m) =>
    m.replace(/\s+/g, ' ')
  )
  expect(
    declared,
    `${name}() must declare \`security ${want}\` exactly once in its header`
  ).toEqual([`security ${want}`])
}

const GRAPH_THREADS_DENY = functionBodyIn(GRAPH_THREADS_SQL, 'forbid_demo_graph_threads')
const GRAPH_THREADS_DENY_CODE = stripComments(GRAPH_THREADS_DENY)

describe('the graph_threads demo lockdown migration', () => {
  it('is the file this test thinks it is', () => {
    expect(GRAPH_THREADS_SQL.length).toBeGreaterThan(500)
    expect(GRAPH_THREADS_SQL).toContain('create trigger forbid_demo_graph_threads')
  })

  it('checks the same two-signal demo test as guardrails.ts isDemoProfile()', () => {
    expect(GRAPH_THREADS_DENY_CODE).toMatch(
      /coalesce\(p\.is_demo, false\) is true or p\.demo_expires_at is not null/
    )
  })

  it('deny fires by raising, never by returning — a silent return is an allowed write', () => {
    const at = GRAPH_THREADS_DENY_CODE.indexOf('demo profiles cannot create or modify graph threads')
    expect(at, 'the refusal message must be present').toBeGreaterThan(-1)
    const preceding = GRAPH_THREADS_DENY_CODE.slice(Math.max(0, at - 60), at)
    expect(preceding, 'the refusal must be the message of a raise').toContain('raise exception')
    expect(GRAPH_THREADS_DENY_CODE).toContain("errcode = 'insufficient_privilege'")
  })

  it('has exactly one `return new` — an unconditional deny, no service-role exemption branch', () => {
    // Unlike enforce_demo_profile_lockdown (three returns: not-a-demo,
    // server-side caller, guards-passed) this trigger has no server-side
    // exemption at all — see the migration's header for why. A second
    // `return new` here would be an undocumented exemption.
    const returns = GRAPH_THREADS_DENY_CODE.match(/return new;/g) ?? []
    expect(returns.length, 'an extra `return new` would be an undeclared exemption').toBe(1)
    expect(GRAPH_THREADS_DENY_CODE).not.toContain('is_service_role_request')
  })

  it('is SECURITY INVOKER, not DEFINER — only the service role ever reaches this trigger, and RLS already bypasses for it', () => {
    expectSecurityModeIn(GRAPH_THREADS_SQL, 'forbid_demo_graph_threads', 'invoker')
  })

  it('pins search_path on the function it defines', () => {
    const definitions = GRAPH_THREADS_SQL.match(/create or replace function public\.\w+\(\)/g) ?? []
    const pins = GRAPH_THREADS_SQL.match(/set search_path = ''/g) ?? []
    expect(definitions.length).toBeGreaterThanOrEqual(1)
    expect(pins.length).toBe(definitions.length)
  })

  it('is BEFORE INSERT OR UPDATE, for each row', () => {
    expect(GRAPH_THREADS_SQL).toMatch(
      /create trigger forbid_demo_graph_threads\s+before insert or update on public\.graph_threads/
    )
    expect(GRAPH_THREADS_SQL).toContain('for each row')
  })

  it('refuses to apply before the migration that creates graph_threads', () => {
    expect(GRAPH_THREADS_SQL).toContain("to_regclass('public.graph_threads') is null")
    expect(GRAPH_THREADS_SQL).toContain('apply 20260817000002_graph_threads.sql before this migration')
    expect(GRAPH_THREADS_SQL).toMatch(/perform p\.is_demo[\s\S]*?from public\.profiles p\s+where false;/)
  })

  it('is safe to apply again: idempotent create/replace + drop-if-exists before create trigger', () => {
    expect(GRAPH_THREADS_SQL).toContain('create or replace function')
    expect(GRAPH_THREADS_SQL).toContain('drop trigger if exists forbid_demo_graph_threads')
    const triggers = GRAPH_THREADS_SQL.match(/create trigger/g) ?? []
    const drops = GRAPH_THREADS_SQL.match(/drop trigger if exists/g) ?? []
    expect(drops.length).toBe(triggers.length)
  })

  it('contains no destructive statement beyond the drop-trigger idempotency guard', () => {
    for (const [, dropped] of GRAPH_THREADS_SQL.matchAll(/\bdrop\s+(\w+)/gi)) {
      expect(dropped.toLowerCase(), `unexpected \`drop ${dropped}\` in a security migration`).toBe('trigger')
    }
    for (const forbidden of [
      'delete from',
      'truncate',
      'alter policy',
      'drop policy',
      'disable row level security',
      'disable trigger',
    ]) {
      expect(stripComments(GRAPH_THREADS_SQL).toLowerCase()).not.toContain(forbidden)
    }
  })

  it('proves the trigger is attached and RLS is enabled before it finishes', () => {
    expect(GRAPH_THREADS_SQL).toContain("tgname = 'forbid_demo_graph_threads'")
    expect(GRAPH_THREADS_SQL).toContain('is not attached to public.graph_threads')
    expect(GRAPH_THREADS_SQL).toContain('relrowsecurity')
  })
})

// ---------------------------------------------------------------------------
// api_tokens: 20260819000001_api_tokens.sql
// ---------------------------------------------------------------------------
// Guards a THIRD, capability-bearing table (binding ruling 5, class 1: same
// treatment as graph_threads and apply_phase_tokens — RLS + trigger deny +
// route refusal — because possession of the plaintext token is the whole
// authority, with no further ownership check of its own once
// lib/access/tokens.ts's validateToken() finds the row). Same source-level-
// scan approach and same warning as the sections above: this proves the SQL
// TEXT has the shape it claims to have, not that Postgres enforces it at
// runtime.
//
// MUTATION-TESTED BY HAND, same procedure the graph_threads section documents:
// with the `raise exception` in forbid_demo_api_tokens() commented out in the
// actual migration file, every assertion in 'the deny fires by raising, not
// returning' below went red — 'has exactly one `return new`' also flipped,
// since the commented-out raise left only a bare `return new;` where the
// guard used to be, collapsing the function to an unconditional allow. The
// migration file was restored unchanged immediately after and `pnpm -F
// @cello/web test lockdown.test.ts` was re-run green before this file was
// finalized.

const API_TOKENS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260819000001_api_tokens.sql'
)

const API_TOKENS_SQL = readFileSync(API_TOKENS_PATH, 'utf8')

const API_TOKENS_DENY = functionBodyIn(API_TOKENS_SQL, 'forbid_demo_api_tokens')
const API_TOKENS_DENY_CODE = stripComments(API_TOKENS_DENY)

describe('the api_tokens demo lockdown migration', () => {
  it('is the file this test thinks it is', () => {
    expect(API_TOKENS_SQL.length).toBeGreaterThan(500)
    expect(API_TOKENS_SQL).toContain('create trigger forbid_demo_api_tokens')
  })

  it('checks the same two-signal demo test as guardrails.ts isDemoProfile()', () => {
    expect(API_TOKENS_DENY_CODE).toMatch(
      /coalesce\(p\.is_demo, false\) is true or p\.demo_expires_at is not null/
    )
  })

  it('deny fires by raising, never by returning — a silent return is an allowed write', () => {
    const at = API_TOKENS_DENY_CODE.indexOf('demo profiles cannot create or modify access tokens')
    expect(at, 'the refusal message must be present').toBeGreaterThan(-1)
    const preceding = API_TOKENS_DENY_CODE.slice(Math.max(0, at - 60), at)
    expect(preceding, 'the refusal must be the message of a raise').toContain('raise exception')
    expect(API_TOKENS_DENY_CODE).toContain("errcode = 'insufficient_privilege'")
  })

  it('has exactly one `return new` — an unconditional deny, no service-role exemption branch', () => {
    const returns = API_TOKENS_DENY_CODE.match(/return new;/g) ?? []
    expect(returns.length, 'an extra `return new` would be an undeclared exemption').toBe(1)
    expect(API_TOKENS_DENY_CODE).not.toContain('is_service_role_request')
  })

  it('is SECURITY INVOKER, not DEFINER', () => {
    expectSecurityModeIn(API_TOKENS_SQL, 'forbid_demo_api_tokens', 'invoker')
  })

  it('pins search_path on the function it defines', () => {
    const definitions = API_TOKENS_SQL.match(/create or replace function public\.\w+\(\)/g) ?? []
    const pins = API_TOKENS_SQL.match(/set search_path = ''/g) ?? []
    expect(definitions.length).toBeGreaterThanOrEqual(1)
    expect(pins.length).toBe(definitions.length)
  })

  it('is BEFORE INSERT OR UPDATE, for each row', () => {
    expect(API_TOKENS_SQL).toMatch(
      /create trigger forbid_demo_api_tokens\s+before insert or update on public\.api_tokens/
    )
    expect(API_TOKENS_SQL).toContain('for each row')
  })

  it('gives api_tokens no insert/update policy for authenticated — only select and delete', () => {
    // The route creates/revokes/touches through the service-role admin
    // client (see the migration header); a signed-in browser holding only
    // its own JWT must be refused both verbs outright by default-deny, with
    // no `using` expression to get wrong.
    expect(API_TOKENS_SQL).toContain('"own api_tokens select"')
    expect(API_TOKENS_SQL).toContain('"own api_tokens delete"')
    expect(API_TOKENS_SQL).not.toContain('"own api_tokens insert"')
    expect(API_TOKENS_SQL).not.toContain('"own api_tokens update"')
  })

  it('is safe to apply again: idempotent create/replace + drop-if-exists before create trigger', () => {
    expect(API_TOKENS_SQL).toContain('create or replace function')
    expect(API_TOKENS_SQL).toContain('drop trigger if exists forbid_demo_api_tokens')
    const triggers = API_TOKENS_SQL.match(/create trigger/g) ?? []
    const drops = API_TOKENS_SQL.match(/drop trigger if exists/g) ?? []
    expect(drops.length).toBe(triggers.length)
  })

  it('contains no destructive statement beyond the drop-trigger idempotency guard', () => {
    for (const [, dropped] of API_TOKENS_SQL.matchAll(/\bdrop\s+(\w+)/gi)) {
      expect(dropped.toLowerCase(), `unexpected \`drop ${dropped}\` in a security migration`).toBe('trigger')
    }
    for (const forbidden of [
      'delete from',
      'truncate',
      'alter policy',
      'drop policy',
      'disable row level security',
      'disable trigger',
    ]) {
      expect(stripComments(API_TOKENS_SQL).toLowerCase()).not.toContain(forbidden)
    }
  })

  it('proves the trigger is attached and RLS is enabled before it finishes', () => {
    expect(API_TOKENS_SQL).toContain("tgname = 'forbid_demo_api_tokens'")
    expect(API_TOKENS_SQL).toContain("public.api_tokens is missing its owner select/delete policies")
    expect(API_TOKENS_SQL).toContain('relrowsecurity')
  })
})

// ---------------------------------------------------------------------------
// apply_phase_tokens: 20260819000003_assisted_apply.sql
// ---------------------------------------------------------------------------
// Guards a FOURTH capability-bearing table (binding ruling 5, class 1) and
// the one member of this family with NO policy for `authenticated` on ANY
// verb, not even select — see that migration's RLS section for why. Same
// source-level-scan approach and same warning as every section above: this
// proves the SQL TEXT has the shape it claims to have, not that Postgres
// enforces it at runtime.
//
// MUTATION-TESTED BY HAND, same procedure documented above: with the `raise
// exception` in forbid_demo_apply_phase_tokens() commented out in the actual
// migration file, 'the deny fires by raising, not returning' and 'has
// exactly one return new' both went red; restored immediately after and
// `pnpm -F @cello/web test lockdown.test.ts` re-run green before this
// section was finalized.

const ASSISTED_APPLY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260819000003_assisted_apply.sql'
)

const ASSISTED_APPLY_SQL = readFileSync(ASSISTED_APPLY_PATH, 'utf8')

const PHASE_TOKENS_DENY = functionBodyIn(ASSISTED_APPLY_SQL, 'forbid_demo_apply_phase_tokens')
const PHASE_TOKENS_DENY_CODE = stripComments(PHASE_TOKENS_DENY)

describe('the apply_phase_tokens demo lockdown migration', () => {
  it('is the file this test thinks it is', () => {
    expect(ASSISTED_APPLY_SQL.length).toBeGreaterThan(500)
    expect(ASSISTED_APPLY_SQL).toContain('create trigger forbid_demo_apply_phase_tokens')
  })

  it('checks the same two-signal demo test as guardrails.ts isDemoProfile()', () => {
    expect(PHASE_TOKENS_DENY_CODE).toMatch(
      /coalesce\(p\.is_demo, false\) is true or p\.demo_expires_at is not null/
    )
  })

  it('deny fires by raising, never by returning — a silent return is an allowed write', () => {
    const at = PHASE_TOKENS_DENY_CODE.indexOf('demo profiles cannot create or modify apply phase tokens')
    expect(at, 'the refusal message must be present').toBeGreaterThan(-1)
    const preceding = PHASE_TOKENS_DENY_CODE.slice(Math.max(0, at - 60), at)
    expect(preceding, 'the refusal must be the message of a raise').toContain('raise exception')
    expect(PHASE_TOKENS_DENY_CODE).toContain("errcode = 'insufficient_privilege'")
  })

  it('has exactly one `return new` — an unconditional deny, no service-role exemption branch', () => {
    const returns = PHASE_TOKENS_DENY_CODE.match(/return new;/g) ?? []
    expect(returns.length, 'an extra `return new` would be an undeclared exemption').toBe(1)
    expect(PHASE_TOKENS_DENY_CODE).not.toContain('is_service_role_request')
  })

  it('is SECURITY INVOKER, not DEFINER', () => {
    expectSecurityModeIn(ASSISTED_APPLY_SQL, 'forbid_demo_apply_phase_tokens', 'invoker')
  })

  it('pins search_path on the function it defines', () => {
    const definitions = ASSISTED_APPLY_SQL.match(/create or replace function public\.\w+\(\)/g) ?? []
    const pins = ASSISTED_APPLY_SQL.match(/set search_path = ''/g) ?? []
    expect(definitions.length).toBeGreaterThanOrEqual(1)
    expect(pins.length).toBe(definitions.length)
  })

  it('is BEFORE INSERT OR UPDATE, for each row', () => {
    expect(ASSISTED_APPLY_SQL).toMatch(
      /create trigger forbid_demo_apply_phase_tokens\s+before insert or update on public\.apply_phase_tokens/
    )
    expect(ASSISTED_APPLY_SQL).toContain('for each row')
  })

  it('gives apply_phase_tokens NO policy at all for authenticated — service-role only', () => {
    // Unlike api_tokens/graph_threads (owner SELECT), nothing in this product
    // ever shows a user their own apply_phase_tokens row — see the
    // migration's RLS section for why. No `create policy` statement at all.
    expect(ASSISTED_APPLY_SQL).not.toContain('create policy')
    expect(ASSISTED_APPLY_SQL).toContain('must have NO policies for authenticated')
  })

  it('is safe to apply again: idempotent create/replace + drop-if-exists before create trigger', () => {
    expect(ASSISTED_APPLY_SQL).toContain('create or replace function')
    expect(ASSISTED_APPLY_SQL).toContain('drop trigger if exists forbid_demo_apply_phase_tokens')
    const triggers = ASSISTED_APPLY_SQL.match(/create trigger/g) ?? []
    const drops = ASSISTED_APPLY_SQL.match(/drop trigger if exists/g) ?? []
    expect(drops.length).toBe(triggers.length)
  })

  it('contains no destructive statement beyond the drop-trigger idempotency guard', () => {
    for (const [, dropped] of ASSISTED_APPLY_SQL.matchAll(/\bdrop\s+(\w+)/gi)) {
      expect(dropped.toLowerCase(), `unexpected \`drop ${dropped}\` in a security migration`).toBe('trigger')
    }
    for (const forbidden of [
      'delete from',
      'truncate',
      'alter policy',
      'drop policy',
      'disable row level security',
      'disable trigger',
    ]) {
      expect(stripComments(ASSISTED_APPLY_SQL).toLowerCase()).not.toContain(forbidden)
    }
  })

  it('proves the trigger is attached, RLS is enabled, and no policy exists — before it finishes', () => {
    expect(ASSISTED_APPLY_SQL).toContain("tgname = 'forbid_demo_apply_phase_tokens'")
    expect(ASSISTED_APPLY_SQL).toContain('relrowsecurity')
    expect(ASSISTED_APPLY_SQL).toContain("tablename = 'apply_phase_tokens'")
  })

  it('never defaults expires_at — a forgotten TTL must fail the insert, not silently outlive its purpose', () => {
    const tableStart = ASSISTED_APPLY_SQL.indexOf('create table if not exists public.apply_phase_tokens')
    const tableEnd = ASSISTED_APPLY_SQL.indexOf('\n);', tableStart)
    const tableBody = ASSISTED_APPLY_SQL.slice(tableStart, tableEnd)
    const expiresLine = tableBody.split('\n').find((l) => l.trim().startsWith('expires_at'))
    expect(expiresLine, 'expires_at column must be defined').toBeTruthy()
    expect(expiresLine).not.toContain('default')
    expect(expiresLine).toContain('not null')
  })

  it('scopes the phase vocabulary to exactly fill/submit', () => {
    expect(ASSISTED_APPLY_SQL).toContain("check (phase in ('fill', 'submit'))")
  })

  it('refuses to apply before application_drafts exists', () => {
    expect(ASSISTED_APPLY_SQL).toContain("to_regclass('public.application_drafts') is null")
    expect(ASSISTED_APPLY_SQL).toContain('apply 20260717000001_harness_tables.sql before this migration')
  })
})
