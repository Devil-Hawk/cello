# Reinvented-wheel audit (2026-07-28)

Repo-wide audit against the owner's rule: **don't reinvent the wheel.** The
reconciliation with our other rule ("every dependency is a tax on self-hosters"):
*small single-purpose libraries are GOOD — using them IS not-reinventing. Heavy
frameworks are the tax.* LangChain/LangGraph and a separate graph DB stay
rejected; the agent loop stays hand-rolled because that is the thing we
deliberately own, and every harness we model on (Claude Code, opencode, oh-my-pi)
hand-rolls it too.

The dominant finding was **not** "should have used a library" — it was **the same
utility written 3–7 times with divergent behaviour**. That is the more damaging
form, because the copies disagree silently.

## DONE

- **Removed `canvas`, `pdf-parse`, `@types/pdf-parse`** (commit `5faf514`).
  Declared, zero imports. `canvas` needs a compiler toolchain + cairo/pango/
  libjpeg headers on every install — the single biggest self-hosting obstacle,
  for code that never ran. Real PDF work uses `unpdf` + `pdf-lib`, untouched.
- **Hand-rolled markdown renderer replaced** — see the copilot front-end rebuild.
  It rendered fenced code as literal ``` and links as raw `[text](url)`, with no
  table support at all.
- **In flight:** hand-rolled retry → `p-retry`; regex HTML strip → `html-to-text`;
  hand-parsed RSS → `rss-parser`; custom LCS diff → `jsdiff`.

## REPLACE — ranked, not yet done

1. **CSV importer corrupts data.** `components/contacts/csv-import.tsx:22-63`
   does `split(',')`, so any quoted field containing a comma (`"Smith, Jane"`,
   `"Director, Engineering"`) silently shifts every following column. Real
   user-facing corruption on the commonest CSV shape. No CRLF or escaped-quote
   handling either. → `papaparse`. Risk LOW (one dialog, no API consumers).
2. **Seven date-diff helpers, all with the same bug.**
   `packages/agents/src/tracker/ghost-detector.ts:24`, `coach/timing.ts:48`,
   `components/pipeline/utils.ts:40`, `lib/utils.ts:44`, `lib/digest/compose.ts:59`,
   `lib/strategy/questions/applicationTiming.ts:24`, plus `timeAgo` in
   `components/settings/sources-tab.tsx:70`. Every copy computes elapsed 24-hour
   periods, not calendar days — applying at 11pm yesterday reads as `0 days` at
   1am today. Every ghost-detection and follow-up threshold sits on this.
   → `date-fns` v3 (`differenceInCalendarDays`, `formatDistanceToNow`).
   Risk MEDIUM: deliberately changes timing by up to a day; `coach.test.ts` and
   `tracker.test.ts` assert current behaviour. **Land as an explicit behaviour
   change with tests updated, never a silent refactor.**
3. **Three concurrency limiters.** `lib/ats/index.ts:336` and
   `lib/harness/executor.ts:920` are byte-identical; `bulk_matcher.ts:91` is a
   third with a `shouldStop` predicate. **Do NOT reach for `p-limit`** — it gives
   a semaphore, not an order-preserving map; you'd rewrite the same wrapper. Move
   one copy to `lib/util/concurrency.ts`, delete the others. ~30 lines. Risk LOW.
4. **Two more hand-rolled HTML strippers** beyond the one being fixed:
   `lib/sources/util.ts:24` (feeds six aggregator adapters) and
   `lib/kb/connectors/url.ts:61,84`. Each decodes a different arbitrary subset of
   entities — `sources/util.ts` handles eight named and exactly two numeric, so
   every other numeric entity survives verbatim into descriptions fed to the LLM.
   → `html-to-text`, already a dependency. ~60 lines. Risk LOW.
5. **Hand-written API body validation** where zod is already used in 7 harness
   files: `app/api/settings/targeting/route.ts:12-38`, `settings/mcp/route.ts:51`,
   `companies/sponsorship/route.ts:97`. → `z.object().safeParse`. ~45 lines. LOW.
6. **Gmail MIME built by string concatenation.** `lib/outreach/gmail.ts:35-86`.
   No header folding at the 998-octet limit, RFC 2047 encoded-word emitted as one
   unsplit token past the 75-char limit, display names with `,` `<` `"` unquoted,
   `8bit` asserted without checking the body. A non-ASCII recipient name produces
   a technically invalid message. → `mimetext` (TS-native, built for the Gmail
   API). Risk MEDIUM — outward-facing; needs a real send test.
7. **Three identical `.env` parsers** in `scripts/{clean-company-names,
   backfill-classification,purge-garbage}.ts`. None handle `#` comments,
   multi-line values, or escaped quotes. Their stated reason ("no npm
   dependencies") is now moot: Node 20.6+ ships `--env-file`. ~57 lines.

## NEEDS OWNER DECISION

- **Registrable-domain extraction is three inconsistent implementations**
  (`lib/sources/util.ts:73` strips only `www.`, so `jobs.acme.com` ≠ `acme.com`;
  `lib/gmail/skip-lists.ts:54` does a proper suffix scan; `provenance.ts:306` a
  third). `skip-lists.ts:43` documents a premise that is false — `extractDomain`
  returns the full host including subdomains. → `tldts` fixes *extraction*, not
  the product judgment those host lists encode. **Risk MEDIUM-HIGH: changes
  company dedup keys against a live DB. Only behind a backfill, never in place.**
- **`parseJsonLoose` has four implementations with opposite failure modes.**
  `lib/harness/llm.ts:112` is greedy (breaks on a stray brace in trailing prose);
  `lib/gmail/classify.ts:118` is non-greedy (truncates at the first `}` of a
  nested object); plus `agents/outreach.ts:147` and `api/scraper/trigger/route.ts:43`.
  **Consolidate to one first** — that is the unambiguous win. Adopting
  `jsonrepair` inside it is a separate, optional call.

## KEEP — deliberately hand-rolled (do not re-litigate)

- `lib/kb/chunk.ts` — pure, deterministic, tested, dependency-free by design.
  *Note:* its character-scanning sentence splitter exists only because
  `tsconfig.json` targets ES2017, which rejects regex lookbehind. Bumping to
  ES2020 would shrink it. Config change, not a dependency.
- `lib/crypto.ts` — correct idiomatic `node:crypto` AES-256-GCM, not a wheel.
  (`IV_LENGTH = 16` where GCM's standard nonce is 12; works, nonstandard, not
  worth changing given ciphertexts already in the DB.)
- `cosineSimilarity`, `jaccardSimilarity` — six lines of correct math each.
- `components/ui/*` shadcn sources — copying shadcn is the intended model.
- `components/ui/segmented.tsx`, `motion.tsx` — the latter is correct *use* of
  framer-motion, centralizing tokens and reduced-motion.
- The 5-line debounce in `jobs/page.tsx:264`, `groupBy` in `strategy/bucket.ts:58`.
- The agent orchestration loop (`executor`, `dynamic`, `replan`, `planner`).

## Categories with nothing to replace (checked explicitly)

Levenshtein/SimHash, LRU/memo caches, deep-equal/clone/merge, virtualization,
client-side SSE parsing, locale collation, AbortSignal combinators, circuit
breakers, task queues — none reinvented, none present.

## Non-library findings worth fixing

- **`packages/scrapers/.venv/` is 110MB on disk** (untracked, so gitignored —
  but its `pyproject.toml` requires Python ≥3.11 while the venv is 3.10).
- **Three tokenizers that disagree.** `lib/jobs/relevance.ts:64` admits it
  duplicates `classify.ts`'s `fold`/`normalizeText`; `role-taxonomy.ts:366` adds
  a third that omits accent-folding, so it diverges on accented input. Likewise
  two skill-synonym tables with **zero overlap** (`relevance.ts:110` vs
  `packages/agents/src/matcher/scoring.ts:64`). No library replaces this — it is
  domain logic — but three disagreeing normalizers is a bug farm.
- **`packages/agents/src/matcher/scoring.ts:312`** uses substring matching
  (`requiredText.includes(skill)`) — exactly the bug class `compileKeyword` in
  `lib/sources/util.ts` was written to avoid ("go" must not match "chicago").
