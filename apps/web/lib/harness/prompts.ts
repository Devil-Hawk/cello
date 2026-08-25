// Harness runtime — prompt document loader.
//
// Loads the house-style prompt documents in apps/web/prompts/** and composes
// them into the SYSTEM half of a call to lib/harness/llm.ts's callLlm. See
// docs/PROMPT-GENERATOR.md for how a new document gets written and reviewed,
// and apps/web/prompts/_shared.md / _voice.md for what the two documents that
// exist today actually say.
//
// WHY DISK, NOT INLINE STRINGS: prompt text is the highest-churn, most
// judgment-heavy content in this codebase (see the prior art this is modeled
// on, ~/career-ops/modes/_shared.md + voice-dna.md) — it needs to be
// reviewable and diffable on its own, not buried inside TypeScript template
// literals next to control flow. apps/web/prompts/*.md is the single source
// of truth; this file only reads and composes it.
//
// VERCEL / SERVERLESS NOTE — read this before touching path resolution:
//
// `fs.readFileSync` with a runtime-constructed path is INVISIBLE to Next's
// build-time file tracer (@vercel/nft walks static imports/requires, not
// string concatenation happening at request time). Without help, a path that
// resolves fine under `next dev` (the files just sit on disk right there) can
// 404/ENOENT once deployed, because the traced serverless function bundle
// never copied prompts/** into itself. There are two honest ways to fix that:
//
//   (a) disk load + tell the tracer what to include, via
//       `experimental.outputFileTracingIncludes` in next.config.js. The
//       documents stay plain, reviewable markdown at rest; one extra config
//       entry makes the trace correct.
//   (b) generate a .ts module from the .md files at build time and import it
//       like any other module — zero runtime fs, but needs a codegen step
//       wired into every build, and the documents stop being plain diffable
//       markdown at rest (they become generated TS string literals).
//
// THIS FILE TAKES (a). Reasoning: `next build`/`next dev` cannot be run in
// this environment to empirically prove a codegen pipeline end-to-end either
// — both approaches are unverifiable by literally building right now — but
// (a) is the officially documented mechanism Vercel itself ships for exactly
// this case (see Next.js docs, "outputFileTracingIncludes", and Vercel's own
// "include additional files in a Function" guide), it needs no build-step
// wiring in package.json for future prompt documents to just work, and it
// keeps every future `prompts/<agent>.md` a plain-review-and-merge markdown
// file with no generated-artifact step in between. apps/web/next.config.js
// sets:
//
//   experimental.outputFileTracingIncludes = { '**': ['./prompts/**/*'] }
//
// '**' is deliberately the broadest possible route-glob key (it matches every
// traced function, not one named route) because prompts.ts gets imported by
// whichever agent files adopt it over time — there is no single fixed API
// route to scope the include to, and under-scoping it is exactly the kind of
// "works for the routes I tested, 404s for the one I didn't" bug this whole
// note exists to avoid.
//
// Path resolution below uses `process.cwd()`, not `__dirname`. `process.cwd()`
// is the one path base Next/Vercel guarantee stays pinned to the project root
// in BOTH `next dev` (cwd = apps/web — see the root package.json's
// `"dev": "pnpm --filter @cello/web dev"` and apps/web's own
// `"dev": "next dev -p 3000"`, always run from apps/web) and the deployed
// function (traced files are copied into the bundle preserving their
// project-root-relative path). `__dirname` is NOT reliable here: it tracks
// wherever webpack/Next actually places the compiled module, which differs
// between the two environments and between dev and a standalone build.
//
// lib/harness/prompts.test.ts exercises this same resolution path with
// `pnpm vitest run` (cwd = apps/web there too) as the one automated check
// available without invoking `next build`.

import { readFileSync } from 'fs'
import { join } from 'path'

const PROMPTS_DIR = 'prompts'

/**
 * Documents every prompt in this system may compose from, by filename (no
 * `.md`, no directory). Add a literal here the day an agent's prompt moves
 * out of its .ts file and into `prompts/<name>.md` — see
 * docs/PROMPT-GENERATOR.md. A name NOT in this list can still be read via
 * `loadModeDoc()` below (e.g. mid-migration, or a document intentionally kept
 * out of the typed list); a name IN this list gets a typed accessor and is
 * covered by `assertPromptDocsResolve()`.
 */
export const PROMPT_DOC_NAMES = [
  '_shared',
  '_voice',
  'cv_tailor',
  'resume_optimizer',
  'outreach',
  'follow_upper',
  'interview_prep',
  'company_researcher',
  'planner',
  'visa',
] as const
export type PromptDocName = (typeof PROMPT_DOC_NAMES)[number]

const cache = new Map<string, string>()

/**
 * Read + cache one prompt document by filename (no extension, no directory).
 * Throws immediately — with the resolved path and the Vercel-tracing hint —
 * if the file is missing or empty.
 *
 * This is intentionally fail-fast, not a silent fallback. A missing prompt
 * document is a deploy-time configuration bug: an agent that quietly ran with
 * an empty rules block would look, from the outside, like a normal successful
 * run — and ship an unconstrained cover letter or outreach email to a real
 * employer with none of the honesty rules attached. Loud and early beats
 * quiet and wrong here.
 */
function readPromptDoc(name: string): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  const path = join(process.cwd(), PROMPTS_DIR, `${name}.md`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `[prompts] could not read prompt document "${name}" at ${path}. If this is happening in a ` +
        'deployed environment (not `next dev`), check apps/web/next.config.js — ' +
        'experimental.outputFileTracingIncludes must cover apps/web/prompts/**/* or the serverless ' +
        `build never bundled it. Underlying error: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`[prompts] prompt document "${name}" at ${path} exists but is empty.`)
  }
  cache.set(name, trimmed)
  return trimmed
}

/** Typed accessor for a known document (see PROMPT_DOC_NAMES). */
export function loadDoc(name: PromptDocName): string {
  return readPromptDoc(name)
}

/**
 * Escape hatch for an agent-specific mode document that hasn't been added to
 * PROMPT_DOC_NAMES yet. Same fail-fast behavior as loadDoc; just not
 * statically typed to the known-document list, so it fits a document that's
 * mid-migration or deliberately one-off.
 */
export function loadModeDoc(agentName: string): string {
  return readPromptDoc(agentName)
}

/** `_shared.md` — the Cello sources-of-truth, anti-fabrication rules, and shared scoring bands. */
export function getSharedDoc(): string {
  return loadDoc('_shared')
}

/** `_voice.md` — the anti-slop voice guardrail for user/contact-facing strings. */
export function getVoiceDoc(): string {
  return loadDoc('_voice')
}

export interface ComposeSystemPromptArgs {
  /**
   * The agent-specific instructions: a loaded mode document
   * (`loadModeDoc('cv_tailor')`) once one exists, or — during migration — the
   * agent's own existing rules string. This is the one part of the system
   * prompt this function does not source itself; callers own their own mode
   * content.
   */
  mode: string
  /**
   * Include `_voice.md`. Default true. Set false only for a prompt that never
   * produces a human/contact-facing string (a pure JSON classification call
   * with no prose field) — the voice guardrail has nothing to constrain there
   * and would just spend cache-prefix tokens for no benefit.
   */
  includeVoice?: boolean
  /**
   * Per-user grounding data that is STABLE across many calls for that user in
   * a session — the resume text, a scoring rubric's fixed anchors — NOT the
   * per-job/per-company variable. Appended last so the whole system prompt
   * reads as: shared rules -> voice rules -> mode rules -> stable per-user
   * data. Callers still set `cachePrefix: true` on the `system` field of the
   * actual `ctx.llm()` call themselves — this function only assembles text,
   * it never touches LlmRunOptions.
   */
  stableContext?: string
}

/**
 * Compose the SYSTEM half of a prompt: `_shared.md` + (optionally)
 * `_voice.md` + the agent's own mode instructions + any stable per-user
 * context (resume, rubric). This is the half that belongs on
 * `cachePrefix: true` — everything in it is identical across every call for
 * the same user/agent, which is exactly what makes it a cache hit from the
 * 2nd call on. The per-call variable (the specific job, the specific
 * company, the specific question) does NOT belong here — build that
 * separately and pass it as `prompt`.
 */
export function composeSystemPrompt(args: ComposeSystemPromptArgs): string {
  const parts = [getSharedDoc()]
  if (args.includeVoice !== false) parts.push(getVoiceDoc())
  parts.push(args.mode)
  if (args.stableContext && args.stableContext.trim()) parts.push(args.stableContext.trim())
  return parts.join('\n\n---\n\n')
}

/**
 * Fail fast on every KNOWN document (PROMPT_DOC_NAMES) at once. Call this
 * where a loud, early failure is preferable to the first real agent call
 * discovering it later (a startup/health-check path, or a test — see
 * prompts.test.ts, which calls this directly).
 */
export function assertPromptDocsResolve(): void {
  for (const name of PROMPT_DOC_NAMES) loadDoc(name)
}
