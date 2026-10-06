# Measured reports

Reports for the runs that need no model. They were produced on 2026-10-05 against
the code in this branch (after) and the frozen release/1 code in `../legacy`
(before).

- `digest/`: six fixture states, before and after.
- `gmail/`: the pattern path over 30 labelled emails (`--no-model`).
- `reply/`: the pattern path over 14 labelled replies (`--no-model`).
- `outreach-template/`: `--stub`, so every draft is the standard template and the
  numbers say how the old and new template fare against the code checks. The
  model rows (grounded, specific) are empty on purpose.

- `judges/`: the production judge (`poolside/laguna-s-2.1:free`) over the `--quick`
  set, run 2026-10-06. Claims accuracy 83% on 6 items (the threshold is 90%, so one
  miss fails it), planted claims caught 3 of 3, specificity 2 of 2.

The writer-backed numbers (outreach and cover letters from model drafts, prep,
research, the follow-up line) have not been measured. On 2026-10-06, after the
free pool reset, `google/gemma-4-31b-it:free` and `gemma-4-26b-a4b-it:free`
answered HTTP 429 "temporarily rate-limited upstream" (Google AI Studio's shared
pool, not this account's daily limit) for the 90 minutes they were polled, so
every outreach draft fell back to the template. `inkling:free` cannot be used as
a judge: OpenRouter serves it only to agentic harnesses. Run again when the writer
answers; each is one command:

```
cd apps/web
sh scripts/evals/outputs/run.sh <feature> --label before
sh scripts/evals/outputs/run.sh <feature> --label after
```
