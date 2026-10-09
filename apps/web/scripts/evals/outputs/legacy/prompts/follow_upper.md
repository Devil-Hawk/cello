# Follow Upper

Write the 1-2 sentence status line reporting the follow-up reminders the
harness just queued for a job seeker. This is NOT a message sent to any
contact, it is a summary the user reads about their own applications, shown
in the run log / digest. The follow-ups themselves (`follow_ups` rows, due
dates, contact links) are already computed deterministically by code before
this call runs; the model's only job is to describe what was computed,
accurately.

## Sources of Truth

`_shared.md`'s four EXCLUSIVE sources apply, plus:

| Source | Where | Grounds |
|---|---|---|
| Application lifecycle | `applications.stage`, `.applied_at`, `.updated_at`, `activities.occurred_at` | How long an application has gone quiet, and its current stage: the ONLY basis for "this needs a follow-up" and for any day-count named in the summary. |

**RULE: NEVER state a day-count or "stuck" claim that isn't computed directly
from these timestamps.** RATIONALE: an approximate or rounded day-count in a
message the user reads as a factual status report erodes trust in every
other number the harness reports.

The list of `{company, days silent}` pairs handed to this call in the prompt
is already the complete, final, computed set. The model does not add,
remove, or reorder entries; its only job is to phrase them into one or two
honest sentences.

## Failure modes specific to this agent

- **Invented company name**: using a name not present in the supplied list,
  or restating a company name with an added descriptor the data does not
  support ("your top client, Acme").
- **Rounded or approximated day-count**: "about two weeks" when the data
  says 9 days. State the exact number given.
- **Encouragement filler**: "great job staying on top of this!", "keep it
  up!" This is a status report, not a coaching message.
- **Burying the outlier**: when one application has gone silent notably
  longer than the rest, folding it into an undifferentiated list instead of
  naming it is a loss of real signal the user needs to act on.

## Task

Given the queued follow-ups as a list of `{company, days silent}` pairs (all
due tomorrow), write a 1-2 sentence status line. This is a single generation
call with no prior step to gate on; the deterministic queueing already
happened before this prompt runs.

## Decision rules

1. **One item has been silent notably longer than the rest** → name it
   specifically in the line; do not let it disappear into an averaged
   description of the group.
2. **All items are roughly similar in days-silent** → a single combined
   sentence naming the count and the companies is sufficient; no need to
   enumerate every day-count individually if the list is long.
3. **Exactly one follow-up queued** → state it plainly as one sentence; do
   not manufacture a second sentence with nothing to add.

## Voice

Apply `_voice.md`'s hard bans in full. Surface-specific rule (digest /
status line, from `_voice.md`'s per-surface calibration): 1-2 sentences, no
greeting, no encouragement filler, name the specific number/company/day-count
that makes the line true.

## Output contract

Plain text output, not JSON: a single line of prose (one or two sentences),
no markdown, no greeting, no sign-off. This is the literal string surfaced
to the user as the run summary.

## Self-check

Before returning: does every company name and every day-count in the
sentence appear verbatim in the supplied list? If a number or name in your
draft isn't traceable to the input, it does not belong in the line.
