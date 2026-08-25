# Cello Prompt Generator

A reusable procedure (meta-prompt + checklist) for producing a new Cello
prompt document in the house style established by `apps/web/prompts/_shared.md`
and `apps/web/prompts/_voice.md`. Use it whenever an agent's prompt is moving
out of a `.ts` template string and into `apps/web/prompts/<agent>.md`, or
whenever you're writing a brand-new agent prompt from scratch.

This document is itself modeled on `~/career-ops/modes/_shared.md` and
`~/career-ops/modes/cover.md` — read those two files (and `voice-dna.md`) once
before using this for the first time. The checklist in Part 3 exists because
those two reference files are good for specific, nameable reasons, not because
they're long.

---

## Part 0 — What "the house style" actually means

A Cello prompt document is not prose describing what the agent should do. It
is a structured document with these properties, all present, all checkable by
a reviewer who has never seen the agent's code:

1. **Externalized, not string-concatenated.** It's a `.md` file a human can
   open, diff, and edit without touching TypeScript control flow.
2. **A Sources of Truth table marked EXCLUSIVE**, naming exactly which inputs
   may ground a claim — inherited from `_shared.md`, extended only with
   agent-specific sources if the agent reads something `_shared.md` doesn't
   already cover.
3. **Bold `RULE:` lines, each with a RATIONALE** — not bare commands. A rule
   without a stated reason invites a future editor to "simplify" it away.
4. **Named failure modes** — the specific shape each fabrication/error takes
   for THIS agent, not a generic "be accurate."
5. **Numbered step procedures with mandatory gates**, when the agent does
   multi-stage work (gather → decide → write). A single paragraph of
   instructions is fine for a one-shot generation call; a procedure with a
   gate is required the moment a step's output depends on a prior step's
   result being validated first.
6. **Concrete decision procedures for judgment calls** — numbered branches,
   explicit capping/threshold rules, and an explicit answer for "what do I do
   when evidence is absent" vs. "what do I do when evidence is contradicted"
   (these are different situations with different correct answers — see
   `_shared.md`'s thin-evidence vs. contradicts-targeting rules).
7. **A voice guardrail with hard, checkable bans** — inherited from
   `_voice.md`, extended only with surface-specific length/format rules.
8. **A self-check step** — "could this sentence appear in output for any
   other job/company/candidate? If yes, rewrite it."
9. **Preference for silence over invention** — an explicit instruction that a
   shorter, honestly-scoped output beats a complete-looking one padded with
   plausible filler.

If a draft prompt document is missing any of these nine, it is not done —
route it back through the checklist in Part 3 before it ships.

---

## Part 1 — Inputs you need before you start

Gather these three things. Do not start drafting with any of them missing —
a prompt document written without the exact output contract in hand will
almost always end up with a key name that doesn't match what the caller
actually parses, which is a silent runtime break, not a compile error (the
harness's `AgentFn` return type is `unknown` at the boundary — see
`lib/harness/types.ts`).

**(a) Agent purpose** — one or two sentences. What does this call produce, and
who/what consumes it? ("Tailor a resume summary + cover letter for one job,
consumed by the apply UI and saved to `application_drafts`.")

**(b) The exact JSON output contract** — copied VERBATIM from the agent's
existing Zod schema (`lib/harness/schemas.ts`) or TypeScript interface, key by
key, including which fields are optional/nullable. Never paraphrase this —
copy it. **CONTRACT LOCK applies to prompt documents too**: a prompt document
that asks the model to return `"coverLetter"` when the schema/caller actually
parses `"cover_letter"` is exactly the kind of silent break the lock rule
exists to prevent, just moved one layer up from the `.ts` file into the `.md`
file that now generates that `.ts` file's prompt string.

**(c) Grounding sources** — which rows/fields this specific agent reads,
beyond what `_shared.md` already documents. Most agents need nothing extra
here (resume + job + dossier + targeting cover almost everything); note it
explicitly when an agent reads something else (e.g. `follow_upper` reads
`applications`/`activities`/`follow_ups` — application lifecycle state, not one
of the four core sources).

---

## Part 2 — The meta-prompt

Feed this to yourself (or to Claude, in a fresh context, with `_shared.md`,
`_voice.md`, and the target agent's current `.ts` file attached) to draft the
new document. Fill in the four bracketed inputs first.

```text
You are writing apps/web/prompts/<agent_name>.md for Cello, a job-search
automation harness. This document will be composed at runtime as:

  system = _shared.md + _voice.md + THIS DOCUMENT + (stable per-user context,
           e.g. resume text, appended separately by the calling agent code)
  prompt = the per-call variable (the specific job / company / question)

_shared.md already defines: the EXCLUSIVE sources of truth (resume, job row,
company dossier, user targeting), the cross-agent anti-fabrication RULEs, the
named failure-mode table, and the shared 0-100 fit-score bands. _voice.md
already defines: the hard buzzword/filler bans, active-voice requirement, and
the self-check. DO NOT restate either — reference them by name where relevant
and write ONLY what is specific to this agent.

AGENT PURPOSE: <fill in Part 1(a)>

OUTPUT CONTRACT (verbatim, do not rename or restructure a single key):
<paste Part 1(b) here>

GROUNDING SOURCES BEYOND _shared.md's four (if any): <fill in Part 1(c), or
write "none — the four core sources cover this agent">

Produce the document with these sections, in this order:

1. `# <Agent Name>` — one-line purpose statement (Part 1a, tightened to one
   sentence).
2. `## Sources of Truth` — reference _shared.md's EXCLUSIVE table by name;
   add a sub-table ONLY for sources beyond the four core ones (Part 1c). If
   there are none, write one sentence saying so — do not invent a table with
   nothing in it.
3. `## Failure modes specific to this agent` — 2-5 named failure modes, each
   as `**Name** — what it looks like here — why it happens here` (not a
   restatement of _shared.md's table; agent-specific instances of it, or new
   ones _shared.md doesn't cover).
4. `## Procedure` — ONLY if the agent does more than one logical step
   (research → gap-check → draft is a procedure; "read the job, write a
   summary" is not). Numbered steps, each with what it reads and what it
   produces. Mark any step whose output must be validated before the next
   step proceeds as a GATE, matching career-ops' "Step 0 — JD Gate
   (mandatory)" pattern. If the agent is genuinely one-shot, write "## Task"
   with a single paragraph instead — do not manufacture a multi-step
   procedure where none exists.
5. `## Decision rules` — the judgment calls this agent has to make that
   _shared.md's generic thin-evidence/contradicted-evidence rules don't
   already cover verbatim. Numbered branches. State explicitly what happens
   when evidence is ABSENT and, separately, what happens when evidence is
   CONTRADICTED — these are different situations with different correct
   answers.
6. `## Voice` — reference _voice.md by name; add ONLY the surface-specific
   length/format rule from _voice.md's "Per-surface calibration" section (or
   a new one if this is a new surface _voice.md doesn't cover yet — in which
   case, also add it to _voice.md itself).
7. `## Output contract` — the JSON shape from Part 1(b), restated exactly,
   as the literal instruction text the model will receive ("Return a single
   JSON object and nothing else: {...}").
8. `## Self-check` — one line: what a reviewer (or the model itself, if
   asked to check its own output) should re-read the draft against before
   returning it. Specific to this agent's most likely failure mode, not a
   generic restatement of _voice.md's self-check.

Style rules for the document itself: bold `**RULE:**` lines carry a stated
RATIONALE, never a bare command. Name failure modes; don't describe them
generically. State what happens on absent evidence AND separately on
contradicted evidence. Prefer "say less, honestly" over "say more,
confidently" everywhere evidence is thin. No em dashes, anywhere, including in
this document about how to avoid em dashes.
```

---

## Part 3 — Reviewer checklist (run this against any prompt document, new or migrated)

Each row names the property from Part 0, plus a check a reviewer can actually
run without reading the agent's code.

| # | Property | Check |
|---|---|---|
| 1 | Externalized document | Is this a `.md` file under `apps/web/prompts/`, not a template string in a `.ts` file? |
| 2 | EXCLUSIVE sources table | Does the document name its grounding sources, either by referencing `_shared.md`'s table or with its own table for anything extra? Could a reader point to exactly which DB fields may ground a claim? |
| 3 | Bold `RULE:` + rationale | Pick any `RULE:` line. Does it have a RATIONALE clause (a "because..." — not just a restated command)? If a rule has no rationale, either add one or demote it out of `RULE:` formatting — an unmotivated rule reads as arbitrary and gets "simplified" away by a future editor who doesn't know why it's there. |
| 4 | Named failure modes | Do the failure modes have names and a "what it looks like HERE" description, or is it generic advice ("be accurate", "don't make things up") that could paste into any prompt for any product? |
| 5 | Numbered procedure + gates | If the agent does multi-stage work, is it numbered steps, not a paragraph? Is any step whose output must be checked before the next step proceeds marked as a gate? |
| 6 | Concrete decision procedures | For every judgment call, is there an explicit answer for absent evidence AND a separate explicit answer for contradicted evidence? (Not one rule trying to cover both — they're different situations.) |
| 7 | Voice guardrail, hard bans | Does the document inherit `_voice.md`'s bans (em dashes, buzzwords, filler openers) rather than re-deriving its own weaker version? Is there a stated length/format for this specific surface? |
| 8 | Self-check | Is there an explicit "before returning, check X" line specific to this agent's likeliest failure — not just `_voice.md`'s generic self-check restated? |
| 9 | Silence over invention | Is there an explicit instruction that thin evidence produces a SHORTER, honestly-scoped output — stated for THIS agent's actual failure mode, not assumed to be inherited implicitly? |
| — | Contract lock | Does every JSON key name in the document's `## Output contract` match the caller's actual Zod schema / TypeScript interface EXACTLY — same names, same optionality? Paste the schema and the prompt's JSON block side by side; they must be identical. |
| — | No secrets/PII leakage | Does the document avoid asking the model to echo raw API keys, tokens, or any field the calling code sanitizes before logging (see `company_researcher.ts`'s `sanitizeErrorDetail` for the pattern)? |

A document that fails any row is not ready to wire in. Fix the document, not
the reviewer's tolerance for the gap.

---

## Part 4 — Wiring it in

Once `apps/web/prompts/<agent_name>.md` passes the Part 3 checklist:

1. Add `'<agent_name>'` to `PROMPT_DOC_NAMES` in `apps/web/lib/harness/prompts.ts`
   so it gets a typed accessor and is covered by `assertPromptDocsResolve()`.
   (It's readable via `loadModeDoc('<agent_name>')` immediately, even before
   this step — adding it to the list is what makes it a first-class, typed,
   fail-fast-checked document rather than an ad hoc string key.)
2. In the agent's `.ts` file, replace the inline rules string with:
   ```ts
   import { composeSystemPrompt, loadModeDoc } from '../prompts'

   const system = composeSystemPrompt({
     mode: loadModeDoc('<agent_name>'),
     stableContext: resumeText, // or whatever is STABLE across this user's calls
   })
   ```
3. Keep the STABLE/VARIABLE split the existing agents already establish: the
   composed `system` string (shared + voice + mode + stable per-user context)
   goes on `ctx.llm({ system, cachePrefix: true, ... })`; the per-call
   variable (the specific job, company, or question) stays in `prompt`. This
   is what makes the shared rules + voice guardrail + resume a real cache hit
   from the 2nd call on instead of a fresh, full-price prefix every time —
   see any existing agent's own comment on this (e.g. `cv_tailor.ts`'s
   `systemWithResume`) for the pattern being replaced.
4. Do NOT change the JSON keys the code parses out of the response as part of
   this migration. The prompt document's `## Output contract` was copied
   verbatim from the existing schema in Part 1(b) — the migration should be
   invisible to every caller.
5. Run `cd apps/web && ./node_modules/.bin/tsc --noEmit -p .` and the
   agent's existing tests. A prompt-text migration should produce a zero-diff
   contract: same exported function signatures, same JSON keys, same DB
   writes — only the string fed to `system` changed shape (and where it lives).

---

## Part 5 — Worked example (Sources of Truth section only, for calibration)

This is what "reference `_shared.md`, add only what's extra" looks like in
practice, using `cv_tailor` (resume + job → tailored summary/letter, no extra
sources beyond the four core ones) versus `follow_upper` (which does read
something extra):

**cv_tailor.md — Sources of Truth section:**
```markdown
## Sources of Truth

The four EXCLUSIVE sources in `_shared.md` (resume, job row, company dossier,
user targeting) cover this agent completely. No additional source is read.
```

**follow_upper.md — Sources of Truth section:**
```markdown
## Sources of Truth

`_shared.md`'s four EXCLUSIVE sources apply, plus:

| Source | Where | Grounds |
|---|---|---|
| Application lifecycle | `applications.stage`, `.applied_at`, `.updated_at`, `activities.occurred_at` | How long an application has gone quiet, and its current stage — the ONLY basis for "this needs a follow-up" and for any day-count named in the summary. |

RULE: NEVER state a day-count or "stuck" claim that isn't computed directly
from these timestamps. RATIONALE: an approximate or rounded day-count in a
message the user reads as a factual status report erodes trust in every other
number the harness reports.
```

Notice what's absent from both: neither restates the resume/job/dossier/
targeting table from `_shared.md`, and neither invents a source that isn't
actually read. That's the calibration to match.
