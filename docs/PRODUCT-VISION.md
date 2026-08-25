# Cello — product vision

> **The coding-agent harness, pointed at job search instead of code.**

Cello is to job applications what Claude Code / opencode / oh-my-pi are to
coding: an open-source, bring-your-own-model **harness** — a driving loop, real
tools, subagents, a visible plan — whose domain is getting a person hired. Not a
dashboard, not a chatbot. You talk to it the way you talk to a coding agent; it
holds the goal and drives toward it.

**What that commits us to:**

- **Open-source, self-hostable, BYO-model.** It runs on the user's own models and
  keys — OpenRouter, a local server (Ollama/vLLM), or a signed-in Claude/Codex/
  Gemini subscription CLI. The provider layer already delivers this. Corollary:
  **every dependency is a tax on contributors and self-hosters** — prefer one
  Postgres and zero extra services over a "correct" second datastore.
- **Reliable like a coding agent.** No tool call, no web search, nothing ever
  hard-crashes the request. Transient failures retry with backoff; permanent ones
  surface an actionable message the model can act on and re-invoke. "Never fail"
  literally is impossible (out-of-credits will fail); "never crash, always recover
  or degrade honestly" is the bar.
- **Clean, contributable code.** It's open source — others will read and extend
  it. Small modules, one job each; pure/testable logic separated from IO; honest
  names; no cleverness that a first-time contributor can't follow.

## Knowledge base — hybrid, in one Postgres (decided)

The KB is a **relationship graph + lexical FTS in a single Postgres**, with
vectors as an opt-in upgrade, never a dependency. Rationale:

1. **Graph as an edges table** (`subject, predicate, object`) over entity tables
   (people, companies, jobs, contacts). Referral intelligence *is* a graph —
   `Priya —worked_at→ Acme`, `Priya —knows→ you`, `Priya —now_at→ TargetCo`.
   Postgres recursive CTEs handle this at Cello's scale (hundreds of companies,
   thousands of jobs, hundreds of contacts). **A dedicated graph DB (Neo4j) is the
   wrong call** — it's a service every self-hoster must run; the open-source tax
   rule forbids it.
2. **FTS for retrieval** — already built (`kb_chunks` + `tsvector` + GIN + a
   ranked search RPC). Deterministic, no extension, no embedding cost.
3. **pgvector opt-in** — documented seam for semantic search; the tool must work
   fully without it (it isn't installed today, by design).

## Data sources for referrals — the honest boundary

- **User's own data is fair game and is the point:** Google Contacts, the user's
  own exported LinkedIn connections, calendar, resume, GitHub. OAuth or file
  import. These feed the referral graph directly and are most of what's needed.
- **Scraping other people's LinkedIn profiles is NOT built into Cello.** It
  violates LinkedIn's ToS and the ban risk lands on the user. The only sanctioned
  path is Apify-BYOK: the user's own Apify account, off by default, clearly
  labeled as their choice and their risk. Never a default, never Cello's own
  scraper.

## Sourcing — everywhere real, nothing fake

Source from every real place (ATS boards, keyless aggregators that fan across
employers, YC / Work-at-a-Startup, and open-web search via the harness's own
`web_search` tool) — never a fixed handful, never US-only by omission. Then two
classifiers gate quality:

- **Provenance** (built): is the source authentic — the employer's own board vs
  an aggregator relaying it vs a scrape.
- **Legitimacy / ghost-job** (next): is this an *active real opening* vs an
  evergreen pipeline-filler or a reposted ghost. Signals: repost frequency, days
  open, a real apply control present, description completeness, corroborating
  hiring signals. Career-ops "Block G" is the blueprint.

## Auto-submit — a deliberate departure from career-ops

career-ops forbids auto-submit on principle (human always clicks). Cello's owner
has explicitly chosen to include it: real browser automation that drives the
form, uploads the tailored PDF, and submits — **with a hard, server-side
confirmation gate on the irreversible click**, and the sensitive-field
guardrails (legal/visa/EEO/salary answered only by the human) ported as-is.

---

> **Keep the sophisticated engine. Simplify the cockpit.**

The advanced capabilities (MCP, multi-agent orchestration, dynamic planning,
fan-out and loops, provider routing) stay in the fully built product. The
mistake would be making every job seeker operate them directly.

Cello should feel like *"Cello understands my search and is quietly running it
with me"* — not *"Cello gives me eleven dashboards and an agent framework to
operate."*

## What a complete Cello does

1. Understand the candidate and their goals
2. Continuously discover opportunities across the internet
3. Rank and explain those opportunities
4. Research companies and referral paths
5. Tailor truthful resumes and application answers
6. Apply automatically when safe
7. Request review only for exceptions
8. Track every application and recruiter response
9. Manage outreach and follow-ups
10. Prepare the candidate for interviews
11. Learn which strategies produce responses, interviews and offers
12. Re-plan the search automatically when the strategy is not working

The loop: career profile → continuous discovery → filtering/matching/research →
referral intelligence → resume + answers + outreach → automatic application or
human exception → submission confirmation and tracking → follow-ups, replies,
interview prep → outcome analytics and strategy adjustment → repeat.

## Where the advanced machinery goes

| Capability | User-facing framing | Advanced surface |
|---|---|---|
| MCP servers | "Connect your career information" — Drive, Gmail, GitHub, Notion, portfolio, calendar | Raw URLs, transports, credentials |
| Multi-agent | "Cello is preparing six applications. Two need your review." | "How Cello did this" — agents, tool calls, evidence, cost |
| Dynamic planning | Plain-language goal; Cello builds and adapts the plan | Plan inspection, DAG internals |
| Fan-out / loops | Campaign progress: "184 companies checked · 23 new roles · 7 strong matches · 4 ready · 1 needs review" | Graph internals |
| Providers | "AI engine: Automatic" | Model routing, cost limits, local execution, privacy |

The internal agent team: Scout, Matcher, Researcher, Networker, Resume
strategist, Tailor, Verifier, Applier, Tracker, Outreach, Interview coach,
Strategist.

## Information architecture

**Primary navigation (5, down from 11):** Today · Opportunities · Applications ·
Copilot · Settings.

**Contextual, not destinations:** company research, referral paths, contacts and
outreach, resume versions, application answers, interview prep, strategy
analytics, notifications/exceptions.

**Advanced / self-hosting:** connections and MCP, sources and connector
coverage, agent execution history, automation policies, model routing, local
execution and privacy, budgets and rate limits, plan inspection, diagnostics.

## Frontend assessment (source-level, 2026-07-28)

| Dimension | Score |
|---|---|
| Visual identity | 8/10 |
| Component consistency | 8/10 |
| Typography and hierarchy | 7/10 |
| Accessibility foundations | 7/10 |
| Responsive design | **4/10** |
| Information architecture | **4/10** |
| Workflow clarity | **4/10** |
| Agentic clarity | **3/10** |
| Trust and status clarity | 5/10 |
| **Overall** | **5.5/10** |

Reads as *"a polished, warm-toned B2B operations dashboard with an
instrument-panel personality"* — not yet *"a calm personal career agent."*

**Keep:** warm paper light surfaces, deep charcoal dark mode, restrained orange
accent, Space Grotesk / Space Mono / DM Sans, surface levels, focus-visible,
reduced-motion, the pulse ribbon, empty states that preview the future UI.

**Fix:**
- Typography is too operational — 14px body, 13px caption, 11px label. Move to
  15–16px reading text; tiny monospace only for timestamps and receipts.
- Navigation exposes org structure (Watch/Pursue/Agents/Analyze/System). The
  user should not have to decide whether something is a job, agent, queue,
  pipeline or notification task.
- Mobile is weak: fixed sidebar always rendered, no drawer or bottom nav, no
  full-screen sheets, seven-column board scrolls horizontally.

## Screen-by-screen direction

- **Login** — public explanation before login; separate Create account / Sign in;
  Gmail connected later with a precise reason, not at identity time; honest
  privacy summary (external AI providers process data).
- **Onboarding** — nine progressive steps, not three. Cello must visibly name
  what missing information prevents.
- **Today** (was Dashboard) — narrative, not counters: *"Cello worked through 27
  new roles overnight. 4 are strong matches, 2 applications are ready, and one
  recruiter replied."* Then: needs your decision · completed by Cello · new
  opportunities · replies and interviews · strategy signal · system health
  (quiet).
- **Opportunities** (was Jobs) — four agent-curated buckets: best matches, needs
  review, newly discovered, dismissed. Each card answers why it is here, the
  deal-breakers, strongest evidence, biggest gap, application mode, referral
  availability, next action.
- **Opportunity workspace** — the most important screen. Full page, not a modal:
  inbox rail · match/company/resume/questions/contacts/prep/timeline · action
  rail with ONE clear state (Cello can apply automatically · review three
  answers · finish on the employer site · already submitted · failed, retry).
- **Applications** — the queue becomes "needs your attention", surfaced on Today
  and inside Applications. Each exception says why Cello paused, what is needed,
  what it recommends, the evidence, the consequence, and whether to reuse the
  answer. After submission, show a receipt with confirmation id.
- **Pipeline** — Cello updates stages from submissions and email; drag becomes a
  correction, not a chore. Default to an actionable list; Kanban optional;
  mobile uses grouped sections.
- **Copilot** — normal composer is prompt + attach + automation mode (Suggest /
  Review / Act) + send. Agent chips, model routing, MCP tools, token usage and
  run graphs move into an "Execution details" drawer.
- **Insights / Prep / Contacts / Notifications** — dissolve into context.

## Colour and trust semantics

Orange = live opportunity, attention, progress. Green = externally confirmed
completion. Amber = review or ambiguity. Red = failure or blocker. Neutral =
pending internal work.

Label provenance explicitly: **AI proposed** · **user verified** · **externally
confirmed**.
