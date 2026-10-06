# Output evals

Small labelled sets, run through the real code paths with free OpenRouter
models, graded by code and by a judge from a different model family. Each script
measures one feature before and after the output work.

```
cd apps/web
sh scripts/evals/outputs/run.sh <feature> --label before|after [--quick] [--no-model] [--stub]
```

Features: `outreach`, `cover-letter`, `dossier`, `gmail`,
`reply`, `digest`, `judges`, `follow-upper`.

- Writer: `google/gemma-4-31b-it:free`. Production judges in the app run on a
  different family; here they are `qwen/qwen3.8-27b:free`. The yardstick judge
  that grades the results is `nvidia/nemotron-3-super-120b-a12b:free`, with
  rubrics in `rubrics/` that are not the production prompts.
- Only model ids ending in `:free` are accepted. The key is read from
  `OPENROUTER_API_KEY` or `~/.cello-secrets.env` and never printed. With no key a
  script prints "skipped" and exits 0.
- The free tier has a daily pool shared by the whole account. When it is spent a
  script stops and says it resets at 00:00 UTC. Answers are cached under
  `.cache/evals-outputs`, so a re-run only pays for what changed.
- `--quick` uses the small subset in `data/` (at most 40 requests). Without it the
  full sets in `~/cello-scratch/evals/<feature>/` are used.
- `--no-model` runs only what needs no model (the pattern paths for mail and
  replies). `digest` never needs one. `--stub` checks a script's plumbing offline;
  its numbers mean nothing.
- `--label before` runs the frozen release/1 code in `legacy/`; `--label after`
  runs the current code and exits 1 when a metric is below `thresholds.json`.
- Results are written as JSON and a markdown table to
  `~/cello-scratch/evals/<feature>/results/` (or `--out DIR`).

`collect-dossier-bundles.ts` freezes the public-source bundles the dossier eval
reads; run it again only to refresh them.
