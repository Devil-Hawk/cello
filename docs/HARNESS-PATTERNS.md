# Harness prompt patterns — what to port from Claude Code, opencode, oh-my-pi

Cello's copilot is a chat loop with one monolithic system-prompt string. Mature
coding-agent harnesses are structured very differently, and those structures are
exactly what produce goal-driven, act-don't-defer behaviour. This is the
blueprint for Cello's prompt/loop craft pass. Sources at the bottom.

## The recurring Cello defect these fix

The copilot runs one tool and defers, doesn't hold the goal, and its prompt is a
wall of rules that still gets ignored (it tried to bypass the submit guard;
review caught it, not the prompt). Every pattern below targets that.

## opencode — layered assembly + mode separation

Its system prompt is **assembled from sources, not written as one string**:
1. a provider-specific base prompt (Claude gets `anthropic.txt`, GPT `beast.txt`)
2. an environment block regenerated per call (model, cwd, platform, today's date)
3. instruction files discovered on disk (`AGENTS.md`/`CLAUDE.md`), each prefixed
   `Instructions from: <path>`
4. an agent-specific override (explore, compaction agents have their own)
5. the user's own override

**Mode separation is a first-class mechanism, not a toggle:**
- `plan.txt` is appended to the last user message when plan mode is active
- `build-switch.txt` is injected on the plan→build transition
- `max-steps.txt` is injected **as a fake assistant message to force a summary**
  when the step budget is hit

**plan agent denies most edits** — permission-restricted per agent. This is the
`ask`/`allow`/`deny` per-tool model, and it maps directly onto Cello's needed
replacement for the single global bypass toggle.

### Port to Cello
- Split the copilot system prompt into: base operating rules + a regenerated
  context block (who the user is, their targeting, their resume presence, budget
  remaining) + the tool catalog + the standing objective. Stop hand-maintaining
  one 200-line string.
- Make plan vs act a real mode with its own appended instruction, not a
  `thinkingMode` flag. The plan is the visible driven todo.
- Cello already injects a forced summary on time-budget exhaustion
  (`fallbackSummary`) — that's the `max-steps.txt` idea, keep it, make it report
  what was found (already done) rather than tool names.

## oh-my-pi — the one genuinely novel idea: Time-Traveling Stream Rules

> "Your rules sit dormant until the model goes off-script. A regex match aborts
> the stream mid-token, injects the rule as a system reminder, and retries from
> the same point. You get course-correction without paying context tax on every
> turn."

Instead of bloating the system prompt with every rule the model might break, the
rules sit **dormant**. A regex watches the output stream; on a match it aborts
mid-token, injects the specific rule as a system reminder, and retries from that
point. Injections survive context compaction.

Why this matters for Cello: our prompt keeps growing to pre-empt every failure
(defer, bypass the guard, score the wrong jobs), and a longer prompt is both
expensive and less obeyed. TTSR inverts it — a short prompt plus targeted
course-correction only when the model actually strays.

**Caveat / where Cello already does better:** the submit/send guard is enforced
**server-side at dispatch**, which is stronger than a stream rule — a stream rule
can be a second layer, never the only one. Use TTSR for *behavioural* drift
(deferring when it could act, scoring irrelevant jobs, padding), not for the
irreversible-action gate, which must stay a hard server check.

### Other oh-my-pi patterns
- **Subagents return schema-validated objects, not prose.** Cello's Workflow tool
  already does this (the `schema` option). Keep it; extend it to the in-product
  agent DAG so steps hand typed results downstream, not blobs.
- **Role-based model routing: `default` / `smol` (cheap subagents) / `slow`
  (reasoning) / `plan` / `commit`.** THIS IS A BUDGET WIN. Cello runs everything
  on one model. Mechanical steps (sourcing decisions, extraction, dedup) should
  run on a cheap model (haiku / gemini-flash / kimi-k2); only judgment (scoring,
  the tailoring rewrite, planning) should touch the flagship. On a fixed $8/month
  this is the difference between draining the budget and not.
- **`todo` tool with phase tracking** — the visible plan the agent drives, the
  thing the user watches instead of a bare "running…".
- **Magic keywords** (`ultrathink`, `orchestrate`) — standalone triggers that
  activate a heavier path without prompt overhead. Cello's analogue: "apply to N"
  should deterministically trigger the source→broaden→score→tailor→confirm
  campaign, not be re-inferred each time.

## Claude Code — hold a plan and drive it

The behaviour Cello is missing, stated plainly: keep a todo list, work it item by
item, and let subagent results come **back into context** so the loop continues
rather than handing off. Act on the next thing; only stop for input that is
genuinely the user's to give. Report the outcome, not the process.

## The synthesis for Cello

1. **Layer the copilot prompt** (opencode) — base rules + regenerated context +
   tools + standing objective.
2. **A visible driven plan** (Claude Code todo + oh-my-pi todo tool) the user
   watches; runs are child sessions of it, not a separate page.
3. **Role-based model routing** (oh-my-pi) — cheap model for mechanical steps,
   flagship only for judgment. Directly protects the monthly budget.
4. **TTSR-style course-correction** (oh-my-pi) for behavioural drift, as a second
   layer over the hard server-side guard for irreversible actions.
5. **Per-tool `ask`/`allow`/`deny`** (opencode) replacing the single bypass
   toggle.
6. **The prompt CONTENT** (grounding, sources-of-truth, voice, calibration) is
   already ported from career-ops in `docs/PROMPT-GENERATOR.md` + `apps/web/prompts/`.
   This doc is about the LOOP and ASSEMBLY, which career-ops (not an agent loop
   itself) doesn't cover.

## Sequencing note

The judgment build currently owns `app/api/copilot/route.ts`. This craft pass
edits the same file, so it runs AFTER that lands — do not collide.

## Sources
- opencode agent system / prompt assembly: https://deepwiki.com/sst/opencode/3.2-agent-system and the assembly gist https://gist.github.com/rmk40/cde7a98c1c90614a27478216cc01551f
- oh-my-pi harness + Time-Traveling Stream Rules: https://github.com/can1357/oh-my-pi and https://jun.ee/archives/oh-my-pi-coding-agent-harness-guide/
- oh-my-opencode build-prompt: https://github.com/code-yeongyu/oh-my-opencode/blob/dev/src/agents/build-prompt.ts
