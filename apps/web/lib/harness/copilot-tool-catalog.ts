// Copilot tool catalog — pure data, ZERO server-only imports.
//
// This is the single source of truth for the copilot's tool metadata (name,
// kind, signature, description, and which harness agent type — if any — backs
// it). Both the server dispatcher (./copilot-tools.ts, which also imports the
// LLM client / supabase admin / agent implementations) and the client page
// (app/(app)/copilot/page.tsx) import from here, so the tool-kind sets are
// defined exactly once. Never add a server-only import to this file — doing
// so would pull service-role/database code into the client bundle.
//
// This file also re-exports the harness's agent-type list (from ./schemas,
// which itself only imports 'zod') as a small, client-safe display catalog —
// the UI's agent picker uses this instead of importing registry.ts's
// AGENT_CATALOG (which drags in every agent implementation, server-only).

import { STEP_AGENT_TYPES } from './schemas'

/** schemas.ts exports the tuple, not the union — derive it here. */
export type StepAgentType = (typeof STEP_AGENT_TYPES)[number]

export { STEP_AGENT_TYPES }

export type ToolKind = 'read' | 'act' | 'run'

export interface ToolSpec {
  name: string
  kind: ToolKind
  /** JSON-ish argument signature shown to the model. */
  signature: string
  desc: string
  /**
   * The harness agent type this tool is backed by, when disabling that agent
   * should also disable this tool. Tools with no natural agent counterpart
   * (the read tools, and optimize_resume which predates the harness) omit
   * this — they are never gated by the agent picker.
   */
  agent?: StepAgentType
}

/**
 * The single source of truth for what the copilot can do. `read` tools are
 * cheap (a query, no LLM). `act` tools make one/few LLM calls (seconds). `run`
 * tools plan + execute a whole agent DAG (can take tens of seconds) — the
 * route gates these by wall-clock budget and runs at most one per turn.
 */
export const COPILOT_TOOLS: ToolSpec[] = [
  {
    name: 'list_jobs',
    kind: 'read',
    signature: 'list_jobs {"query"?:string,"dreamOnly"?:boolean,"fresh"?:boolean,"limit"?:number}',
    desc:
      'List the user\'s tracked jobs (newest first). query filters by title; dreamOnly restricts to dream ' +
      'companies; fresh restricts to just-discovered roles. Each row includes both jobId AND companyId — use ' +
      'companyId directly with get_dossier/research_company, never guess one from a company name.',
  },
  {
    name: 'list_runs',
    kind: 'read',
    signature: 'list_runs {}',
    desc: 'Recent agent runs with status + token usage (for context on what has already run).',
  },
  {
    name: 'explain_match',
    kind: 'read',
    signature: 'explain_match {"jobId":string}',
    desc: 'Read a job\'s stored match analysis (score, skills matched, gaps, seniority fit). If the job has not been matched yet, says so.',
    agent: 'matcher',
  },
  {
    name: 'get_application',
    kind: 'read',
    signature: 'get_application {"jobId"?:string}',
    desc: 'With jobId: the application + any draft for that job. Without: a summary of all applications by stage.',
  },
  {
    name: 'list_contacts',
    kind: 'read',
    signature: 'list_contacts {"query"?:string}',
    desc: 'The user\'s saved networking contacts (name, title, email, relationship).',
  },
  {
    name: 'get_dossier',
    kind: 'read',
    signature: 'get_dossier {"companyId":string}',
    desc:
      'Read the stored public-source dossier for a company (summary, comp, visa signal). If none exists yet, ' +
      'this says so — follow up with research_company to build one rather than reporting the signal as ' +
      "unknown or asking the user to check it themselves.",
    agent: 'company_researcher',
  },
  {
    name: 'check_sponsorship',
    kind: 'read',
    signature: 'check_sponsorship {"companyNames":string[]}',
    desc:
      'Zero-cost H-1B sponsorship SIGNAL (likely/unknown, never a guarantee) for one or more company names, ' +
      'checked instantly against a curated public DoL filing-history list — no LLM call, no dossier required, ' +
      'works for any company whether or not it has been researched yet. This is the FIRST tool to reach for on ' +
      "a \"does X sponsor visas\" ask, including for filtering a whole list of companies at once. Only escalate " +
      "to research_company (real LLM cost, live page fetches) when the ask also needs the rest of a dossier " +
      "(funding, culture, comp) or a first-party careers-page statement, not just this signal.",
  },
  {
    name: 'web_search',
    kind: 'read',
    signature: 'web_search {"query":string,"limit"?:number}',
    desc:
      'Search the open web for anything Cello does not already know — a company fact, a recent event, docs for ' +
      'an unfamiliar tool, checking a claim. Free by default (DuckDuckGo); automatically upgrades to Exa if the ' +
      'user has configured that BYOK key in Settings. Returns raw titles/URLs/snippets from THIRD-PARTY pages — ' +
      'unverified, not facts, and never a job lead on its own: for discovering NEW job postings (beyond Cello\'s ' +
      'own tracked sources), use source_jobs instead — it already falls back to this same search as a last ' +
      'resort and VERIFIES every hit against a live posting before it is ever treated as a job. Read-only: this ' +
      'cannot browse further, take any action, or change anything.',
  },
  {
    name: 'source_jobs',
    kind: 'act',
    signature: 'source_jobs {"query"?:string,"limit"?:number}',
    desc:
      'Search 11 keyless job-aggregator APIs (TheMuse, Arbeitnow, RemoteOK, HN "Who is hiring", Y Combinator, and ' +
      'more) for fresh postings, auto-track any new companies they name as suggestions, and insert what is new — ' +
      'right here, no separate run to go watch. If those free sources still come up short after broadening ' +
      '(adjacent titles, relaxed location/seniority), this automatically falls back to the harness\'s own ' +
      'web_search tool as a last resort — site:-scoped queries against real ATS boards, every hit verified ' +
      'against a live posting before it becomes a job — and reports that in notes. query narrows by role/keyword ' +
      '(omit it to derive keywords from the resume); limit caps results (default 20, max 40). No LLM calls, so ' +
      'it works even with no key configured. Use this instead of trigger_run for an ordinary "find more jobs" ' +
      "ask. If a query inserts 0 new jobs, that's a signal to broaden and call it again with an adjacent query " +
      '(a synonym title, a wider net) before concluding nothing is out there — do not stop at one empty pass. ' +
      'Returned rows include companyId — use it directly with get_dossier/research_company for any company ' +
      'worth checking.',
    agent: 'sourcer',
  },
  {
    name: 'score_jobs',
    kind: 'act',
    signature: 'score_jobs {"query"?:string,"limit"?:number,"jobIds"?:string[]}',
    desc:
      'Score a SMALL batch of the user\'s unscored jobs against their resume and persist match_score + ' +
      'match_details (the same two-tier triage the rest of the product uses), inline in this conversation. ' +
      'COSTS REAL MONEY PER JOB — limit defaults to 10 and is capped at 15; do not raise it without the user ' +
      'asking, and do not call this repeatedly in one turn to route around the cap. Omit BOTH jobIds and query ' +
      'ONLY when the ask is genuinely "score whatever is unscored" — it then falls back to oldest-first. When ' +
      'the user names criteria that narrow which jobs matter (a role, seniority, company trait), prefer passing ' +
      'the specific jobIds you already identified from list_jobs/source_jobs; if you have not (or the pool is ' +
      'larger than what you listed), pass query (e.g. "AI Engineer") instead and it ranks the user\'s unscored ' +
      'jobs by relevance to that ask itself (title/description word matching, not oldest-first) and scores the ' +
      'top matches. Either way, do not let this default to oldest-first when the ask was about which roles fit, ' +
      'not which are oldest. If nothing unscored matches the query it automatically broadens to the newest ' +
      'unscored jobs and says so (relevance.broadened) rather than scoring nothing. The response\'s jobResults ' +
      'gives a per-job status/reason (scored/excluded/no-verdict/not-found) for every id considered — a job ' +
      'with no description is still scored from its title (lower confidence, never a bare "failed"), and an ' +
      'excluded job says exactly why (quality/targeting) instead of silently vanishing from the count. Use this ' +
      'instead of trigger_run for an ordinary "score/match my jobs" ask, and it is also how you answer "which ' +
      'of my jobs suit my resume" — score them, don\'t ask.',
    agent: 'matcher',
  },
  {
    name: 'optimize_resume',
    kind: 'act',
    signature: 'optimize_resume {"jobId":string}',
    desc: 'Score the user\'s resume against a job (ATS score, missing/matched keywords) and produce an honesty-constrained rewrite preview.',
  },
  {
    name: 'tailor_cv',
    kind: 'act',
    signature: 'tailor_cv {"jobId":string}',
    desc: 'Draft a tailored resume summary + cover letter for one job (rephrases true resume content only, never fabricates).',
    agent: 'cv_tailor',
  },
  {
    name: 'draft_outreach',
    kind: 'act',
    signature: 'draft_outreach {"jobId"?:string,"contactId"?:string}',
    desc: 'Draft a short, personalized cold-outreach email (subject + body) grounded in the user\'s real resume. Returns a preview; the user saves/sends it from Contacts.',
    agent: 'follow_upper',
  },
  {
    name: 'research_company',
    kind: 'run',
    signature: 'research_company {"companyId":string}',
    desc:
      'Assemble + store a public-source company dossier (funding/news/culture/tech, comp range, visa signal) for ' +
      'ONE company. Fetches live public pages. This is the tool that finds out whether a company sponsors visas ' +
      'or what stage it has raised to — call it yourself rather than telling the user those facts are unknown or ' +
      'asking them to go look. For MORE THAN ONE company, use research_companies instead of calling this in a ' +
      'loop — one batch call beats N serial turns and is how you avoid exhausting your step budget.',
    agent: 'company_researcher',
  },
  {
    name: 'research_companies',
    kind: 'run',
    signature: 'research_companies {"companyIds":string[],"limit"?:number}',
    desc:
      'Batch version of research_company: research several companies AT ONCE, fanned out internally with bounded ' +
      'concurrency, in a single tool call — this is how you verify/research a list of companies without burning a ' +
      'turn per company. Pass every companyId the ask needs checked (use the companyId already returned by ' +
      'list_jobs/source_jobs — never invent one). COSTS REAL MONEY PER COMPANY, so batch size defaults to 5 and is ' +
      'capped at 8 regardless of how many ids you pass; call again for the rest rather than raising limit past the ' +
      'cap. Returns one result row per company id with its own status/reason — a company that could not be found ' +
      'or researched never silently disappears from the response, and one bad id never fails the whole batch. For ' +
      'a zero-cost visa-sponsorship-only signal across many companies (no dossier needed), check_sponsorship is ' +
      'cheaper and instant — reach for this when the ask needs the rest of a dossier (funding, culture, comp) too.',
    agent: 'company_researcher',
  },
  {
    name: 'prep_interview',
    kind: 'act',
    signature: 'prep_interview {"jobId":string}',
    desc: 'Build + store an interview prep kit for one job: tailored questions + STAR stories mined from the user\'s real resume.',
    agent: 'interview_prep',
  },
  {
    name: 'trigger_run',
    kind: 'run',
    signature: 'trigger_run {"goal":string}',
    desc:
      'Plan + execute a full autonomous multi-agent DAG server-side, in the background, for a goal genuinely ' +
      'bigger than a few direct tool calls — an explicit unattended or repeating campaign the user asked for ' +
      '(e.g. "keep sourcing and drafting applications for anything above 90 while I\'m away"). NOT the default ' +
      'for ordinary "find/score/tailor/draft" requests: those have their own direct tools (source_jobs, ' +
      'score_jobs, tailor_cv, draft_outreach, prep_interview, research_company) — call those yourself, one at a ' +
      'time, and only reach for this when the ask cannot reasonably be narrated as a handful of tool calls in ' +
      'this conversation.',
  },
  {
    name: 'search_kb',
    kind: 'read',
    signature: 'search_kb {"query":string,"limit"?:number}',
    desc: 'Full-text search the user\'s knowledge base (pasted notes, indexed web pages, their resume, and any Apify-sourced documents they opted into) and return ranked, citable chunks with title/url. Says so if nothing matches.',
  },
  {
    name: 'remember_preference',
    kind: 'read',
    signature: 'remember_preference {"text":string}',
    desc:
      'Record something the user just told you about what they want, so it survives this conversation. ' +
      'Use it the moment they state a standing constraint or taste — "Series A+ only", "no big tech", ' +
      '"nothing that needs relocation before March", "I would take less cash for real equity". Keep it ' +
      'to one short sentence in THEIR words, not your paraphrase. Do NOT use it for a one-off instruction ' +
      'about the current task ("find 10 of these now"), for anything already expressible in their targeting ' +
      'settings (job function, seniority, country, language, remote-only — those are filters, not tastes), ' +
      'or for something you inferred rather than were told. Re-stating an existing preference refreshes it ' +
      'instead of duplicating it, so recording again is safe when they repeat themselves.',
  },
]

/** Tools that can take tens of seconds (whole-DAG / many live fetches). */
export const RUN_TOOLS = new Set(COPILOT_TOOLS.filter((t) => t.kind === 'run').map((t) => t.name))
/** Tools that make one/few LLM calls (a few seconds each). */
export const ACT_TOOLS = new Set(COPILOT_TOOLS.filter((t) => t.kind === 'act').map((t) => t.name))
/** Cheap, no-LLM query tools. */
export const READ_TOOLS = new Set(COPILOT_TOOLS.filter((t) => t.kind === 'read').map((t) => t.name))
const VALID_TOOLS = new Set(COPILOT_TOOLS.map((t) => t.name))
const TOOL_BY_NAME = new Map(COPILOT_TOOLS.map((t) => [t.name, t]))

export function isRunTool(name: string): boolean {
  return RUN_TOOLS.has(name)
}
export function isActTool(name: string): boolean {
  return ACT_TOOLS.has(name)
}
export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name)
}
export function isValidTool(name: string): boolean {
  return VALID_TOOLS.has(name)
}
export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_BY_NAME.get(name)
}
export function isStepAgentType(value: unknown): value is StepAgentType {
  return typeof value === 'string' && (STEP_AGENT_TYPES as readonly string[]).includes(value)
}

/**
 * Render the tool catalog for the system prompt. When `enabledAgents` is
 * given (a strict subset of all agent types), tools backed by a disabled
 * agent are left out of the prompt entirely — the model shouldn't be offered
 * an option it will just be refused for. `dispatchTool` still hard-enforces
 * this independent of what the model was shown (defense in depth).
 */
export function toolsPromptBlock(enabledAgents?: ReadonlySet<StepAgentType>): string {
  const tools = enabledAgents
    ? COPILOT_TOOLS.filter((t) => !t.agent || enabledAgents.has(t.agent))
    : COPILOT_TOOLS
  return tools.map((t) => `  - ${t.signature}\n      ${t.desc}`).join('\n')
}

/** Display metadata for the agent picker — mirrors registry.ts's AGENT_CATALOG
 *  blurbs (kept here, not imported from registry.ts, so this stays client-safe). */
export interface AgentCatalogEntry {
  id: StepAgentType
  label: string
  description: string
}

// --- MCP tool namespacing -----------------------------------------------------
//
// Remote tools from a user-configured MCP server (lib/mcp/*) are namespaced as
// `mcp:<server>:<tool>` so they can never collide with a built-in tool name
// above. This is pure string handling — no DB/network access — so it stays
// safe to import from the client bundle alongside the rest of this file.
// Actual server lookup + dispatch lives in lib/harness/copilot-tools.ts
// (dispatchMcpTool), backed by lib/mcp/registry.ts.

export const MCP_TOOL_PREFIX = 'mcp:'

export interface ParsedMcpToolName {
  serverName: string
  toolName: string
}

/** True for any syntactically well-formed `mcp:<server>:<tool>` name — this is
 *  a NAMING CHECK ONLY. It does not mean the server exists, is enabled, or
 *  actually has that tool; dispatchMcpTool re-verifies all of that against
 *  the DB before ever calling out to a server (defense in depth, same
 *  contract as isAgentEnabledForTool below). */
export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null
}

/** Split `mcp:<server>:<tool>` into its parts. Only the FIRST colon after the
 *  prefix is significant — the tool name (server-controlled, untrusted) may
 *  itself contain colons and is taken verbatim as everything after it. */
export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const idx = rest.indexOf(':')
  if (idx <= 0) return null
  const serverName = rest.slice(0, idx)
  const toolName = rest.slice(idx + 1)
  if (!serverName || !toolName) return null
  return { serverName, toolName }
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}:${toolName}`
}

export const AGENT_CATALOG_UI: AgentCatalogEntry[] = [
  { id: 'sourcer', label: 'Sourcer', description: "Discover/refresh open jobs from the user's tracked companies (official ATS APIs)." },
  { id: 'matcher', label: 'Matcher', description: 'Score jobs against the resume and explain the fit (skills matched, gaps, seniority).' },
  { id: 'enricher', label: 'Enricher', description: 'Add comp, seniority, and insider-connection signal from contacts/Gmail.' },
  { id: 'cv_tailor', label: 'CV Tailor', description: 'Tailor a resume summary + cover letter for a specific job (true content only).' },
  { id: 'applier', label: 'Applier', description: 'Build an application draft + handoff/submit via official ATS APIs (human-approve by default).' },
  { id: 'verifier', label: 'Verifier', description: 'Check a draft for completeness and knock-out questions before submission.' },
  { id: 'follow_upper', label: 'Follow-upper', description: 'Draft a follow-up or cold-outreach message for an application or contact.' },
  { id: 'interview_prep', label: 'Interview Prep', description: 'Generate tailored interview questions + STAR stories from the real resume.' },
  { id: 'company_researcher', label: 'Company Researcher', description: 'Research a company from public sources: funding/news/culture, comp, visa signal.' },
]
