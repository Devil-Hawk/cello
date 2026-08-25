# Contributing to Cello

Thanks for looking at the internals. This page is short on ceremony and specific about the parts of this codebase that will surprise you.

## Setup

```bash
git clone https://github.com/Devil-Hawk/cello.git
cd cello
pnpm install
cp apps/web/.env.example apps/web/.env.local   # your Supabase URL + keys
pnpm dev
```

Python side (optional, only for the career-page scraper):

```bash
cd packages/scrapers && pip install -e ".[dev,render]" && scrapling install
```

You need your own Supabase project. Apply `supabase/migrations/` in filename order. Migrations are additive and idempotent; a file whose header says it is destructive tells you exactly when it is safe to apply, and the answer is never "now".

## The gates

Every change passes all of these before it is worth reviewing:

```bash
pnpm lint
pnpm typecheck
pnpm test                                   # full suite, 2,500+ tests
cd packages/scrapers && python -m pytest    # if you touched Python
```

## The rules that are enforced by tests, not by review

Cello has source-level invariant scans. They read other files and fail when new code breaks a guarantee written down elsewhere. If your PR turns one red, the scan is right and the code is wrong until proven otherwise.

1. **Model calls go through the chokepoint.** `callLlm` and `callEmbedding` in `lib/harness/llm.ts` are the only paths to a provider. Constructing a provider client anywhere else, including via LangChain model classes, fails `spend-chokepoints` and `graph-chokepoints`. This is how the monthly spend cap stays unbypassable.
2. **Employer text is framed.** Any text an employer wrote (postings, career pages, scraped HTML) enters a prompt only through `frameJobText`. New prompt-building files must be classified in the `injection-chokepoints` ledger with a reason.
3. **Graphs are invoked through one door.** `lib/graph/invoke.ts` is the only caller of `graph.invoke`/`graph.stream`. It enforces thread ownership, demo expiry, and per-request spend context.
4. **No unbounded id lists in querystrings.** Ownership scoping uses SQL joins. `in-scoping-chokepoints` flags any `.in()` whose argument is not provably bounded.
5. **Nothing sends or submits without a human click.** If your feature drafts something deliverable, the delivery step is a human action. This is a product invariant, not a style preference.

If you change a scan, mutate the code it protects and confirm the scan goes red before you commit. `pnpm mutation:scans` automates the common cases.

## Code style

- Smallest working diff. Reuse the helper that already exists before writing a new one.
- No abstractions with one caller. No config for values that never change.
- Comments state constraints the code cannot show. They do not narrate the code.
- A deliberate shortcut gets a `ponytail:` comment naming the ceiling and the upgrade path.

## Pull requests

- One concern per PR.
- Say what breaks without your change, or what was impossible before it.
- Include the gate output (or let CI speak).
- New behavior comes with the smallest test that fails when the behavior breaks.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
