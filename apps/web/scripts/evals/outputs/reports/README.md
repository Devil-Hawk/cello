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

The model-backed numbers (outreach, cover letters, prep, research, mail and reply
models, judges, the follow-up line) have not been measured. The free OpenRouter
pool for the account was used up for the day (it resets at 00:00 UTC), and a
script stops with that message instead of retrying. Each is one command:

```
cd apps/web
sh scripts/evals/outputs/run.sh <feature> --label before
sh scripts/evals/outputs/run.sh <feature> --label after
```
