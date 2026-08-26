# `lib/access` — demo access codes

The owner issues a 72-hour code. The holder is signed into an **isolated demo
workspace** — a separate, real Supabase auth user — where every feature works
for real against seeded data. The owner can see what was done with the code.

**Operator runbook (turn-on order, verification SQL, proofs, known gaps):
[`docs/demo-access-codes.md`](../../../../docs/demo-access-codes.md).**
Read it before applying anything: the two migrations this feature needs are not
applied to any database yet, and applying them out of order fails by design.

---

## The one idea this module is built on

**Isolation is not implemented here.** A demo is a different auth user, so the
RLS policies that already scope every table by `auth.uid()` do the work. Nothing
in this directory grants or denies access to a row.

What RLS *cannot* answer is three questions that are not about whose rows you
may read:

| Question | Answered by |
| --- | --- |
| How much money may this session spend? | `demoSafeApiKeys`, `demoProfilePreferences`, `demoSettingsGate` + `lib/harness/spend.ts` |
| May it deliver an email? | `demoSendGate` |
| Is it still inside its 72 hours? | `demoSessionGate` (mirrored in `middleware.ts`) |

Everything in `guardrails.ts` is one of those three, and every decision in it
**fails closed** — an unreadable profile, a missing deadline, an unparseable
timestamp all refuse. This codebase has already been bitten by the opposite
(`lib/outreach/guardrails.ts`'s follow-up window fell through to `allowed: true`
on a malformed date, because every comparison against `NaN` is false).

---

## Files

| File | Role |
| --- | --- |
| `codes.ts` | Generating, normalizing, hashing and expiring a code. Pure, `node:crypto`. The code is stored **only** as SHA-256. |
| `guardrails.ts` | The three policies above, as pure functions. No DB, no network — imports safely from routes, the harness, cron and client components. |
| `session.ts` | "Is this request a demo, and which code is it?" Server-only; uses the **service-role** client for every question after "who are you". |
| `audit.ts` | Writing `access_code_events`. Five sanitizer layers; never throws; bounded by a deadline so a slow insert cannot cost a request its result. |
| `scrub.ts` | The text gate `audit.ts` runs everything through. |
| `seed-demo.ts` | Filling a fresh demo workspace. Idempotent, deterministic, and it refuses to touch anything that does not already look like a demo. |
| `fixtures/` | The seeded content: 12 fictional companies, 40 fictional postings, contacts, drafts, a résumé, a pipeline with history. |

---

## Both layers, always

Every guarantee that can be reached without a route handler is enforced twice,
and the split is deliberate:

- **Application layer** (this module) runs *before* the write and can answer in
  a sentence a person can read.
- **Database layer** (`supabase/migrations/20260803000003_demo_profile_lockdown.sql`)
  catches the paths no route handler is on. `profiles`' only UPDATE policy is
  `using (auth.uid() = id)` — no `with check`, no column list — and PostgREST
  hands every signed-in browser a direct write path to its own row. Without the
  trigger, one devtools request (`update profiles set is_demo = false where id =
  auth.uid()`) defeats the cap, the send refusal and the deadline at once,
  because all three read that flag.

`demoLockdownGate(error)` maps the trigger's refusal (SQLSTATE `42501` **and** a
message matching `/demo profiles cannot/i`) back onto the same gate the
application would have returned, so the same event gets the same answer
whichever layer sees it first. It matches on both the code and the message on
purpose: `42501` also covers a plain grant or RLS denial that has nothing to do
with a demo.

Where the two disagree, **the narrower one is the application's** — e.g. the
trigger lets a demo *lower* its cap, and `demoSettingsGate` refuses every budget
write.

---

## Chokepoints you must not add a fourth to

Three files load API keys, and all three finish on
`lib/harness/keys.ts` `applyDemoKeyGuards`:

```
lib/harness/keys.ts     loadApiKeys          (admin / cron context)
lib/apikeys.ts          getDecryptedApiKeys  (request context)
lib/outreach/config.ts  readOutreachConfig   (outreach prefs + keys)
```

`demo-chokepoints.test.ts` pins that list at **three** and fails if a fourth
appears. That test exists because the header on `keys.ts` once asserted "nothing
calls a provider without first asking one of them for a key" and it was false —
`readOutreachConfig` read `preferences` itself and handed a decrypted key
straight to `makeLlmRunner`, so an expired demo could still spend through
`/api/outreach/draft` and `/api/outreach/follow-up`.

Sending is deliberately **not** enforced there: delivering mail needs a Gmail
token, not an API key, so a send never passes through a key loader. That guard
lives at the two routes that can deliver — `app/api/outreach/send` and
`app/api/digest/send`.

---

## Rules for changing anything here

1. **Fail closed.** A profile you could not read is not a profile that is not a
   demo. `isDemoProfile` ORs *both* signals (`is_demo` **or** `demo_expires_at`)
   because a row carrying a demo deadline is a demo even if the flag was dropped
   by a partial update — and `middleware.ts` and the lockdown trigger both make
   the same test, so a session can never be a demo for one and an ordinary user
   for another.
2. **The subject of an audit gets no vote.** `session.ts` uses the service-role
   client for the determination *and* the write, with no parameter for a caller
   to pass the wrong one. `access_code_events` has no insert policy.
3. **Never gate a demo restriction on `resolveDemoContext()` returning
   non-null.** It answers "who should this activity be attributed to", not "may
   this happen". Guards read `profiles.is_demo` directly.
4. **Mutation-test every security assertion.** Remove the property the test
   protects and confirm it goes red. This codebase has already shipped two tests
   that stayed green — including one in `guardrails.test.ts` that an import
   alone satisfied.
5. **If you add a guarded field to the lockdown trigger, add it to the trigger's
   `update of (...)` list too.** `lockdown.test.ts` fails if you don't, and a
   guarded column missing from that list silently stops being guarded.
6. **`middleware.ts` restates `demoSessionGate` rather than importing it** — it
   cannot import it, because `codes.ts` pulls in `node:crypto` at module scope
   and Next 14 bundles middleware for the Edge runtime. The duplicate is pinned:
   `demo-chokepoints.test.ts` runs one truth table through both and requires
   identical answers, case by case, including the boundary instant.

---

## Tests

| File | What it holds in place |
| --- | --- |
| `guardrails.test.ts`, `guardrails.budget.test.ts` | The three policies and the spend ledger's composition with `seed-demo.ts`. |
| `lockdown.test.ts` | Reads the migration SQL and asserts its shape: every privilege-bearing field has a guard, every guard raises (never returns), every raise carries `insufficient_privilege`, the exemption is decided by the verified token before the database role, exactly three `return new`. |
| `demo-chokepoints.test.ts` | The three key loaders, the two send routes, and the middleware/guardrails equivalence. |
| `audit.test.ts`, `seed-demo.test.ts`, `codes.test.ts` | The sanitizers, the seeder's safety gate and idempotency, the code alphabet and expiry. |
| `../harness/pre-migration-schema.test.ts` | That the tolerant profile read survives a database that predates `20260803000002` — **note it covers six files, and `loadApiKeys` is not one of them.** |
