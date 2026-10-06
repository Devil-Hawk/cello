Stale: this describes the engine as replayed in K8d. Chat (K24a) rewrites it.

# The agent engine

This is how Ask Cello works underneath: one orchestrator the person talks to, a few specialists it can hand work to, twelve tools, nine skills, and a small backend that lets the same agent run on a schedule. It replaces the earlier Copilot loop in `lib/graph/copilot.ts`, which stays in place until the list under Retiring is cleared.

The rule that shapes everything: the agent can draft, but it cannot send. Anything that goes out to another person is a row the person approves.

## How it fits together

```
person ──► POST /api/agent/stream ──► openUserTurn (checks, lease) ──► executeTurn
                                                                          │
sweeper (pg_cron, every minute) ─┐                                        ▼
slice handover (after 240 s)  ───┼─► POST /api/agent/continue      createCelloAgent
Run now (UI) ────────────────────┘        │ signed, answers 202            │
                                          ▼                                ▼
                                   handleContinue ──► executeTurn   orchestrator (Deep Agents)
                                                                    ├─ 12 Cello tools + file tools
                                                                    ├─ skills (read /skills/<name>/SKILL.md)
                                                                    └─ task ──► scout, writer (workflows)
                                                                              └► researcher (loop, 8 calls, read only)
```

- `lib/agents/factory.ts` is the one place an agent is built (`createCelloAgent`). Nothing else may call `createDeepAgent(`, `createSubAgent(` or `createAgent(`, and only `lib/agents/model.ts` may call `new ChatOpenRouter(`. `lib/agents/chokepoints.test.ts` fails the build on a second door, and `scripts/mutation-check-scans.ts` proves each scan fires.
- `lib/agents/run.ts` runs one request: it renews the lease, records the task, streams, hands over at the deadline, and turns every failure into one plain sentence.
- Specialists are reached with `task`. A subagent never gets `task`, so delegation is at most two levels deep (a test asserts it).

## The stack

| Piece | What it is |
|---|---|
| Agent | `deepagents` (`createDeepAgent`) on `langchain` v1 middleware |
| Orchestration | `@langchain/langgraph`: `StateGraph` for Scout and Writer, `Send` for fan-out, `interrupt` for questions and handovers |
| Model door | `@langchain/openrouter` `ChatOpenRouter`, only in `lib/agents/model.ts`, with the person's own key |
| Checkpoints and memory | `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`) in the `langgraph` schema |
| Outside tools | `@langchain/mcp-adapters` `MultiServerMCPClient`, after the SSRF and DNS checks |
| Streaming | `@langchain/langgraph-sdk` `FetchStreamTransport` and `useStream` on the page |
| Tracing | `@langfuse/langchain` `CallbackHandler`, one trace per request or occurrence |
| Scheduling | `croner`, `@vercel/functions` `waitUntil`, `pg_cron` and `pg_net` |

Free tiers only: Vercel Hobby (300 s functions), Supabase free, GitHub free. Evals use only OpenRouter models whose id ends in `:free`.

## Guards

Every agent loop gets the same stack from `guardStack` in `lib/agents/middleware.ts`, outermost first:

1. `CelloDemoRules`: a demo cannot send, submit, or use outside tools. The tool list stays the same; the call is refused.
2. Model call limit: 24 for the orchestrator, 8 for the Researcher.
3. Tool call limit: 30, and 4 for `task`.
4. Context editing: old tool results are cleared past 60,000 tokens.
5. `CelloDeadline`: past the request's deadline, it saves and hands over.
6. Model fallback: free models only, and none for a demo.
7. Model retry: 3 tries with backoff on a transient error, never on a budget cap.
8. `CelloSpend`: reserve before and settle after every model call, through `lib/agents/spend-port.ts`. It adds no budget check of its own.
9. `CelloUntrusted`: results that carry other people's text reach the model as quoted data, with images, data URLs, long query strings and closing tags removed.
10. Tool retry: 2 tries on a transient error.

Deep Agents adds skills, the file tools, `task`, summarization (once) and tool-call patching before these.

## The twelve tools

One registry (`lib/agents/tools/registry.ts`) feeds both the agent and Cello's own MCP server at `/api/mcp`, so a tool has the same name, description and arguments in both. Read tools take `response_format` and `limit`. Write tools take an `idempotency_key`. A failure returns `{ error, fix }`. Over MCP nothing is sent and `remember` is not served.

| Tool | What it does |
|---|---|
| `find_roles` | Finds and ranks roles for a query, or reads the saved shortlist |
| `get_role` | One role: requirements, why it fits, the chance with its evidence |
| `triage_role` | Records "interested", "not for me" or "applied" for a role |
| `research` | Researches up to eight companies, people or topics, and saves a dossier for each |
| `people` | Contacts at a company, with how sure each email is |
| `my_profile` | The person's resume, preferences, dealbreakers, taste or history |
| `remember` | Saves a fact, only from the person's own quoted words |
| `create_artifact` | Writes one document (resume, cover letter, email, follow-up) as a draft |
| `update_artifact` | Revises a document as a new version |
| `pipeline` | Lists applications by stage, moves one, attaches a document |
| `request_approval` | Queues a send or a submit for the person to approve. Returns at once |
| `schedule_task` | Creates or changes a Scheduled task |
| `search_knowledge` | Searches what the person saved, and their memory |

The Researcher's `web_search` and `read_page` are not among them. Only the Researcher holds them.

## Specialists

- Scout: a graph that sources, scores and saves a shortlist. Fans out across sources, four at a time.
- Writer: draft, review, revise once, save. The reviewer runs code checks (every employer, title and number appears in the profile; length; one ask) and then a judge from a different model family.
- Researcher: a loop of at most 8 model calls with read-only access. Fewer than two independent sources means "not enough public information".
- Applier: not a subagent. It is reached only through an approved `submit_application`.

Fan-out (`lib/agents/fanout.ts`) runs at most four branches at once, each with its own caps, and reports each as ok, partial or failed so one failure never loses the rest.

## Skills

Nine skills live in `apps/web/skills/<name>/SKILL.md`: role-fit, tailor-resume, cover-letter, cold-outreach, follow-up, company-research, visa-sponsorship, negotiation, search-strategy. The orchestrator sees each name and description and reads the file when it applies. Each folder has an `evals.json` (three trigger cases and an output case with plain checks). A skill's `description` must be a quoted string: an unquoted colon makes the loader skip the skill.

## Memory and files

The agent sees a virtual file system: `/memories/taste.md` (read only: the person's last twenty reactions to roles), `/artifacts` (their documents, versioned), `/skills` (read only) and a scratch area. The orchestrator cannot write `/memories`, `/artifacts` or `/skills` directly; documents change only through `create_artifact` and `update_artifact`, and what the person tells Cello to keep only through `remember`.

## Approvals

`request_approval` writes a row in `approvals` with the document version and a hash of exactly what would go out. Nothing is sent. The person approves in Needs you, which calls `POST /api/approvals/[id]`, and that runs the one send path (`lib/outreach/send.ts`) or the one submit path (`lib/apply/approve.ts`) once, stores a outcome, and tells the conversation. A second click returns the same outcome. If the draft changed after it was queued, the approval is refused until the person has seen the new version. A Scheduled task set to "act within my rules" may approve what its stored rules name, through the same code; an application is never auto-approved unless the rule says so.

## Scheduled tasks

A Scheduled task is a saved instruction, a schedule and an autonomy level (`ask`, `draft` or `act`). Each occurrence runs the same agent on its own thread, so its context stays small. When it ends, its result is added to the task's own conversation. Autopilot is one template of this (migration `20261006000607`).

- The schedule is structured (every day, weekday, week or N hours, a time, a time zone). Code writes the cron string with `croner`; nobody types cron.
- A thread is leased with one conditional `UPDATE` on `graph_threads` (`lease_until`, `lease_holder`). No advisory locks, which the pooler breaks.
- A request stops starting work after 240 seconds, saves a checkpoint (`durability: 'sync'`) and calls `/api/agent/continue`, which picks the thread up in a fresh request.
- Every minute `agent_sweep()` (pg_cron, through pg_net) finds due tasks and work whose request died, and posts a signed request. When nothing is due it makes no request.
- A task more than 12 hours late is marked missed instead of running at the wrong time. Stalled work is resumed five times at most.

Signing: `X-Cello-Signature` is the hex HMAC-SHA256 of the exact request body with `AGENT_CONTINUE_SECRET`. The body carries `exp`, at most five minutes ahead. Every refusal answers 401 with the same body.

Setup, once per environment:

```
# the checkpointer and store tables (direct connection, port 5432 or 54322 locally)
pnpm setup:checkpointer

# the sweeper reads its target and its secret from Vault
select vault.create_secret('https://<host>/api/agent/continue', 'agent_continue_url');
select vault.create_secret('<AGENT_CONTINUE_SECRET>', 'agent_continue_secret');
-- local: http://host.docker.internal:3000/api/agent/continue
```

Set `AGENT_CONTINUE_SECRET` (16+ characters) in the app to the same value. `supabase/checks/agent_engine.sql` proves the migrations: row rules, no anon grants, both Realtime tables, the cron job, the autopilot move.

## The UI API

All routes answer 401 `{ error, message }` when signed out. A refusal before streaming is JSON `{ error, message }` where `message` is one plain sentence to show as it is.

**Stream.** `POST /api/agent/stream`, body as the hook's transport sends it:

```
{ "input": { "messages": [{ "type": "human", "content": "..." }] },
  "command": { "resume": "<answer to a question>" },
  "context": { "conversationId": "<uuid, omit to start a new one>" } }
```

Use `new FetchStreamTransport({ apiUrl: AGENT_STREAM_URL, fetch: agentFetch })` from `lib/agents/client.ts`. `agentFetch` keeps the route's sentence in `statusText` (over HTTP/2 it is otherwise empty), and `errorMessage(error)` reads it back.

Statuses: 400 empty message, 402 add a key (`needs_key`), 403 demo ended, 404 not found, 409 busy or an earlier-Copilot conversation. The response is `text/event-stream`. Event names are the stream mode, with the subagent path after a bar when it comes from inside one:

- `metadata`: `{ run_id, thread_id, conversation_id }`, always first. `run_id` is the trace id.
- `values`, `updates`, `messages` (a pair of message and metadata), `custom`: as LangGraph sends them. Messages are plain dicts with a `type`. A `custom` event `{ kind: "activity", text }` is a short line for a specialist at work.
- `values|tools:<id>` and the like: the same, from inside a specialist.
- `error`: `{ error: "budget" | "needs_key" | "failed", message }`. The stream then ends.

A message with `additional_kwargs.cello_event` is an approval result told to the conversation, not something the person typed. Hide it or show it as a note.

**Saved conversation.** `GET /api/agent/threads/[id]/state` returns `{ values: { messages }, interrupts }` for a reload. `interrupts` holds a question Cello is waiting on. A handover is never shown.

**Approvals.** `GET /api/approvals?status=pending|executing|done|failed|skipped|all` returns `{ approvals: [{ approval, artifact: { id, title, type, version, preview } }] }`. `POST /api/approvals/[id]` with `{ decision: "approve" | "skip", edits?, acknowledge_version? }` returns `{ copy, approval, error?, fix? }` with the status the send path chose. `copy` is the line to show.

**Scheduled tasks.** `GET /api/scheduled-tasks` returns tasks each with `card: { schedule, last, next }`. `POST` takes `{ name, instruction, schedule: { every, at?, weekday?, hours?, timezone }, autonomy?, rules? }`. `PATCH /api/scheduled-tasks/[id]` takes any of those plus `status: "active" | "paused"`. `DELETE` removes one. `POST /api/scheduled-tasks/[id]/run` starts one now and answers 202. A demo cannot create or start one (403).

**Documents.** `GET /api/artifacts?type=&job_id=&limit=&offset=` lists them. `GET /api/artifacts/[id]` returns the document and every version, newest first, with who wrote it. `POST /api/artifacts/[id]` with `{ content }` saves the person's edit as a new version and scores how far they moved from Cello's draft.

**Taste.** `GET /api/taste` returns the person's last twenty reactions to roles. It uses the person's own session, so row rules decide ownership. A reaction is taken back by undoing it, not by editing taste.

**Realtime.** Subscribe to `postgres_changes` on `agent_tasks` and on `approvals`, filtered by `user_id=eq.<id>`. An `agent_tasks` root row (`parent_id` null) is one request or occurrence; its children are the specialists and fan-out branches. Status is `queued`, `working`, `waiting`, `done`, `partial` or `failed`, and `statusLabel` in `lib/agents/tasks.ts` gives the words to show.

**Words the UI uses.** Say task, draft, Needs you and Scheduled task. Do not say run, thread, tick, step, graph or agent run. The sentences in `lib/agents/copy.ts` are written to be shown as they are.

## Tracing

`agentCallbacks` (`lib/observability/langfuse.ts`) attaches a Langfuse `CallbackHandler` to every invocation, joined to the request's trace. It is not created when content capture is off for that account (demos by default). Approvals and edits are scored on the trace of the draft they concern: `draft_approved`, `draft_skipped`, `draft_edited` (how far the person moved the words, 0 to 1), and `job_applied` and `job_dismissed` from reactions.

## Evals

Live evals use free models only (`lib/evals/agent/free.eval.ts` refuses any other id) and are skipped unless `RUN_AGENT_EVALS=1`. They cache every request on disk, back off on 429 and 5xx, and cap real requests per process (`AGENT_EVAL_MAX_REQUESTS`, default 450). Reports go to `~/cello-scratch/evals/agent`.

```
cd apps/web
RUN_AGENT_EVALS=1 AGENT_EVAL_MODE=old|new  nice -n 19 ./node_modules/.bin/vitest run lib/evals/agent/tool-selection.eval.test.ts
RUN_AGENT_EVALS=1                          nice -n 19 ./node_modules/.bin/vitest run lib/evals/agent/injection.eval.test.ts
RUN_AGENT_EVALS=1 AGENT_EVAL_MODE=old|new  nice -n 19 ./node_modules/.bin/vitest run lib/evals/agent/researcher.eval.test.ts
RUN_AGENT_EVALS=1                          nice -n 19 ./node_modules/.bin/vitest run lib/evals/agent/skills.eval.test.ts
```

Bars are in `lib/evals/agent/thresholds.json`. Judges come from a different model family than the generators they judge.

### Measured so far

Before (the earlier Copilot, its own prompt and 19 tools, same 30 messages, qwen3.8-27b, laguna-s-2.1 and nemotron-3-super, free, run on 2026-10-05):

| | overall (majority) | delegation | single |
|---|---|---|---|
| earlier Copilot | 60% (18/30) | 50% (5/10) | 65% |

Per model: qwen 77%, nemotron 60%, laguna 17%. Laguna is a reasoning model and 24 of its 30 answers were cut off before any JSON at the 700 token cap used for that run, so the majority was in effect decided by qwen and nemotron, who were both right on 17 of 30. The cap is now 2500 for the earlier Copilot's prompt; that run was not finished (see below), so treat 60% as a floor.

Not measured yet: the new orchestrator on the same cases, the injection set, the researcher set and the skill checks. OpenRouter's free allowance for this account is 1000 requests a day across all `:free` models, and rate-limited retries on two of the models used it up while the baseline ran. It resets at 2026-10-06 00:00 UTC. The commands above are ready; run the old mode again first (the token cap changed), then the new one, and write both into this table. The prompts for the orchestrator, the Researcher and the nine skills are therefore the first versions and have not been tuned against these numbers.

## Environment

`AGENT_CONTINUE_SECRET` (required for slices and the sweeper), `AGENT_CONTINUE_URL` and `AGENT_FREE_MODELS` (optional). See `apps/web/.env.example`.

## Retiring

Nothing below is deleted yet, because other code may import it. Each can go once its last importer moves:

- `lib/graph/copilot.ts`, `app/api/copilot/route.ts`, `lib/harness/copilot-tool-catalog.ts`, `lib/mcp/tool-schemas.ts`
- `lib/graph/runs.ts`, `lib/graph/autopilot.ts`, `app/api/harness/run`, `app/api/harness/autopilot`, the run pass of `app/api/harness/cron`, `.github/workflows/autopilot-cron.yml`
- `lib/harness/planner.ts`, `replan.ts`, `goals.ts`, `chains.ts`, `dynamic.ts`, `lib/harness/agents/strategist.ts`
- `components/copilot/runs-panel.tsx`, `graph-view.tsx`, `step-card.tsx`, and the `copilot` surface value in `graph_threads`
- `dispatchTool` in `lib/harness/copilot-tools.ts` once A2A moves to the registry, and the mem0 paths once memory moves fully onto the store

Not covered by the demo wipe: the checkpoints and store rows of an expired demo live in the `langgraph` schema, which the service client cannot reach. A demo's conversation expires with its `graph_threads` row, so nothing resumes it.
