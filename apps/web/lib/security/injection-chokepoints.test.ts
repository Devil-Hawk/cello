// Guards the invariant lib/security/job-text.ts states about itself: that
// EMPLOYER-CONTROLLED job text is framed as data at every place it is
// interpolated into a prompt.
//
// WHY THIS FILE EXISTS
//   lib/mcp/registry.ts has had MCP_SAFETY_PREFACE since MCP shipped, so every
//   remote tool result re-entering the model's context is framed as untrusted
//   third-party data. Job descriptions had nothing, in any file, ever —
//   grepping lib/harness/prompts.ts, packages/agents/src/** and lib/resume/**
//   for injection-framing language returned zero hits — even though a job
//   posting is written by whoever posted the job and flows into the matcher,
//   the resume tailorer, the outreach drafter, the goal judge and the analyst.
//
//   The framing helper on its own does not fix that. Framing that one agent
//   remembers to call is framing the next agent forgets, and the failure is
//   invisible in review because nothing looks wrong with the new call site in
//   isolation — it only misbehaves relative to a guarantee documented in
//   another file. That is the exact shape of the bug
//   lib/harness/spend-chokepoints.test.ts was written for (a second, unguarded
//   path to a model), and this test copies its technique: assert the guarantee
//   ACROSS files, at the source level, because that is what catches the NEXT
//   call site — the one nobody is looking at yet.
//
// HOW IT WORKS
//   A deliberately broad scan finds every file that both references a
//   `.description` and builds a prompt. Every file it finds must appear in
//   exactly one of the three ledgers below, each with a note saying why. An
//   unclassified file is a hard failure: somebody has to look at it and decide
//   which list it belongs in. That is the whole mechanism — the scan does not
//   try to be clever about what a prompt is, because no regex reliably
//   distinguishes "passes the description along" from "puts it in a prompt".
//   A human does, once, and writes it down here.

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Tests run with cwd = apps/web; the ledger spans the monorepo. */
const REPO_ROOT = path.resolve(process.cwd(), '../..')

const SCAN_ROOTS = ['apps/web/lib', 'apps/web/app/api']

/**
 * References to some entity's `description`. Broad on purpose — it captures
 * company descriptions and observation descriptions too, and those land in the
 * NOT_JOB_TEXT ledger with a reason. Over-capturing costs one line of ledger;
 * under-capturing costs an unframed prompt.
 *
 * `.description` rather than `job.description` specifically because
 * lib/harness/goals.ts calls its field `candidate.description` — a narrow
 * marker would have missed a real, LLM-facing job-text site on the first try.
 */
/**
 * langgraph port step 9 (lib/context/assemble.ts, the one context-assembly
 * door) added three more idioms worth catching here alongside the original
 * job-description ones: a call to formatKbContext (lib/kb/store.ts) — the
 * unframed KB-context formatter, so a caller that reaches for it directly
 * near a prompt is exactly the same shape of gap this scan already catches
 * for a bare job description; a kb search hit's `.content` field
 * (lib/kb/types.ts#KbSearchHit — the field the scan's own header literally
 * calls "what you put in an LLM prompt"); and a company dossier's `.summary`
 * field (lib/dossier/store.ts#CompanyDossierRow), the other employer-derived
 * prose this codebase interpolates into prompts. Narrow identifiers
 * (`hit.content`, `dossier.summary`/`dossierRow.summary`) rather than a bare
 * `\.content\b`/`\.summary\b` on purpose — checked against every current file
 * in SCAN_ROOTS before landing: a bare `.content` would have dragged in a
 * dozen unrelated files (LLM response `.content`, HTTP body `.content`, ...)
 * that reference a description nowhere near this file's job-text concern,
 * turning "over-capture costs one ledger line" into a false-positive flood.
 */
// `\??\.` (not a bare `\.`) in front of `summary`/`content` so the marker
// still matches TypeScript optional chaining (`dossier?.summary`,
// `hit?.content`) — the idiom assemble.ts itself uses at every one of its
// dossier-summary call sites. A bare `\.` only matches the unguarded form
// and goes vacuously green on the more defensive, more common spelling; the
// pre-existing `.description` marker above already tolerates any receiver
// (it has no leading identifier at all), so this brings the other two
// markers in line with it instead of leaving a real inconsistency.
//
// `\brationales\b` — step 6 (lib/graph/distill.ts, the reward-loop
// distiller) quotes a sample of judge verdicts' rationale text (itself
// built from framed job text, e.g. matcher gaps/missingSkills) into a
// distillation prompt. Checked against every current file in SCAN_ROOTS
// before landing, same discipline as the other narrow identifiers here: the
// plural only matches this file and lib/harness/goals.ts (already
// PROMPT_BUILDERS/PENDING_WIRING) — a bare `\brationale\b` would have
// dragged in a dozen unrelated eval/verdict-store files that reference a
// verdict's rationale field without ever building a prompt from it.
const DESCRIPTION_MARKER =
  /\.description\b|\bjobDescription\b|\bjob_description\b|\bformatKbContext\b|\bhit\??\.content\b|\bdossier(?:Row)?\??\.summary\b|\brationales\b/

/** The file talks to a model, or builds the string that will. */
const PROMPT_MARKER =
  /\bprompt\s*[:=]|\bsystem\s*:|callLlm|\bllm\s*\(|composeSystemPrompt|\.complete\s*\(|\w*Prompt\s*[(=]/

/**
 * A file has actually adopted the helper: it IMPORTS the module and CALLS it.
 *
 * Both halves are required because lib/harness/goals.ts already has an option
 * literally named `frameJobText` (an injectable framer seam it declares itself,
 * defaulting to a plain `.slice()`). Matching the bare identifier would score
 * that file as protected while its default path still puts raw posting text in
 * a prompt.
 */
const FRAMING_IMPORT = /from\s+['"][^'"]*lib\/security\/job-text['"]/
const FRAMING_CALL = /\b(?:frameJobText|frameJobTextList|prepareJobText)\s*\(/

/**
 * PROMPT BUILDERS — these interpolate employer-controlled job text into a
 * prompt, so each one must call frameJobText().
 *
 * Enumerated by hand, from reading them. The note on each is the wiring
 * instruction for whoever does the mechanical follow-up.
 */
const PROMPT_BUILDERS: Record<string, string> = {
  'apps/web/lib/harness/agents/matcher.ts':
    'scoreJobWithLlm builds `Description:\\n${job.description}` into the user prompt (~L178). ' +
    'Highest-volume model call in the product, so this is the widest exposure.',
  'apps/web/lib/harness/agents/bulk_matcher.ts':
    'buildTier1Prompt inlines each job description into a batched list (~L132) — one hostile ' +
    'posting sits next to 49 honest ones in the same prompt. Use frameJobTextList(), which ' +
    'exists for this shape: one preface for the batch, one marker per job.',
  'apps/web/lib/harness/agents/cv_tailor.ts':
    'The tailoring path (~L82-L89). THE one that ends in a document sent to an employer under ' +
    'the user’s name; also the site that should run checkTailoringContainment on the output.',
  'apps/web/lib/harness/agents/outreach.ts':
    'Role description block in the drafting prompt (~L133) — the redirect-the-email payload.',
  'apps/web/lib/harness/agents/resume_optimizer.ts':
    'jobBlock() (~L79), used by the score/rewrite/rescore passes; the rewrite pass writes resume text.',
  'apps/web/lib/harness/agents/interview_prep.ts':
    'buildPrompt() JOB DESCRIPTION block (~L129).',
  'apps/web/lib/harness/goals.ts':
    'judgeCandidate() (~L921-L929). Already has a `frameJobText?: JobTextFramer` seam and its own ' +
    'MCP_SAFETY_PREFACE-modelled system-prompt note, but defaultJobTextFramer is a bare .slice(). ' +
    'Wiring is per-field, so pass the description through frameJobText and leave title/company/location ' +
    'on the plain truncating framer rather than repeating the preface four times.',
  'apps/web/app/api/outreach/judge/route.ts':
    'sourceFacts (~L105) concatenates the resume and the job description as the judge’s grading input.',
  'apps/web/lib/harness/agents/analyst.ts':
    'generateFullAnalysisPrompt interpolates jobDescription (~L200s) — the langgraph port (step 9) ' +
    'moved this out of app/api/agents/analyze/route.ts (that route now only calls runAgentUnit(' +
    "'analyst', ...) and builds no prompt itself) and off packages/agents' AnalystAgent entirely; " +
    'this file frames it directly, no cross-package hop needed.',
  'apps/web/lib/context/assemble.ts':
    'The langgraph port step 9 context-assembly door: buildMatchContext/buildOutreachContext/' +
    'buildInterviewContext/buildTurnContext all interpolate employer-derived prose (a kb search ' +
    "hit's .content, a company dossier's .summary) into context blocks headed for a prompt — " +
    'lib/harness/agents/matcher.ts, lib/harness/agents/outreach.ts, ' +
    'lib/harness/agents/interview_prep.ts and lib/graph/copilot.ts all interpolate this file\'s ' +
    'output. Framed at the source (this file), never at a consumer — every employer-derived ' +
    'string is wrapped in frameJobText/frameJobTextList before it leaves one of the four ' +
    'builders, so it is framed from day one and never appears in PENDING_WIRING below.',
  'apps/web/lib/graph/distill.ts':
    'Step 6, the reward-loop distiller: buildDistillPrompt (~L200) quotes a SAMPLE of judged ' +
    "verdicts' rationale text into the distillation prompt — those rationales can carry model " +
    'output built from framed job text (matcher gaps/missingSkills, a judge summary — see ' +
    'lib/graph/verify/matcher.ts / cv-tailor.ts / outreach.ts). Uses frameJobTextList, same ' +
    "batch shape as lib/harness/agents/bulk_matcher.ts, so this file's own scan-mutation check " +
    'documented in its header stays true.',
}

/**
 * NOT YET WIRED. Every builder above starts here, because the helper landed
 * before the call sites were changed and the files are owned by other agents.
 *
 * This list is a RATCHET, and the assertion below is a set equality rather
 * than a subset check on purpose: adding framing to a builder makes this test
 * fail until the file is deleted from this list, and REMOVING framing from a
 * wired builder fails it too. Either way the list cannot go stale, which is
 * the only thing that makes a known-offender list worth having.
 */
const PENDING_WIRING: string[] = [
  'apps/web/lib/harness/agents/outreach.ts',
  'apps/web/lib/harness/agents/resume_optimizer.ts',
  'apps/web/lib/harness/agents/interview_prep.ts',
  'apps/web/lib/harness/goals.ts',
  'apps/web/app/api/outreach/judge/route.ts',
]

/**
 * FORWARDERS — they load or pass job text but never put it in a prompt
 * themselves. Framing here would double-wrap the text a builder already
 * fences, so they are exempt BY CLASSIFICATION, not by omission.
 */
const FORWARDERS: Record<string, string> = {
  'apps/web/lib/graph/autopilot.ts':
    'Selects jobs and hands them to the matcher/tailorer agents (moved from lib/harness/autopilot.ts ' +
    'in the langgraph port step 10 — draftTask now reaches cv_tailor/applier through ' +
    "runAgentUnit('cv_tailor'|'applier', ...), which builds its own separately-framed prompt).",
  'apps/web/lib/harness/copilot-tools.ts':
    'loadOwnedJob() reads the description and passes it to the agent that builds the prompt.',
  'apps/web/app/api/mcp/route.ts':
    'The MCP server surface (langgraph port step 2): every tool call, including ones that load a ' +
    "job's description, goes straight to dispatchTool() — the SAME function copilot's own " +
    "dispatchExecute calls (already ledgered above). This route builds no prompt of its own; it " +
    "doesn't currently match this scan's CANDIDATES filter at all (no `.description`/prompt marker " +
    'in its source), but is listed here per ruling 7\'s instruction so the reasoning is on record ' +
    'the same way it is for copilot-tools.ts.',
  'apps/web/app/api/a2a/route.ts':
    "The A2A endpoint (langgraph port step 3): parses an inbound message into an id-only request " +
    "(lib/a2a/agent.ts's A2aAgentRequest — jobIds/companyId/jobId, no free-text override field at " +
    'all: see that file\'s header for why interview_prep\'s resumeText override is deliberately not ' +
    'exposed here) and hands it to invokeGraphForUser. Builds no prompt of its own and does not ' +
    "currently match this scan's CANDIDATES filter (no `.description`/prompt marker in its source, " +
    'or in lib/a2a/executor.ts, which is the same shape) — listed here per ruling 7\'s instruction, ' +
    'same as app/api/mcp/route.ts above.',
  'apps/web/app/api/agents/match/route.ts': 'Loads the job row, calls scoreJobWithLlm.',
  'apps/web/app/api/resume/documents/route.ts': 'Passes {title, company, description} to cv_tailor.',
  'apps/web/app/api/resume/optimize/route.ts': 'Passes the job to resume_optimizer.',
  'apps/web/app/api/outreach/draft/route.ts':
    'Reads jobs.description into draftInput.jobDescription and hands it to generateOutreachDraft. ' +
    'The prompt is built one layer down, in lib/harness/agents/outreach.ts (already on ' +
    'PROMPT_BUILDERS and PENDING_WIRING) — this route only carries the text there. Worth ' +
    'remembering what that pending wiring means HERE though: the draft this produces is an email ' +
    'sent under the user own name, so an instruction hidden in a job posting has an unusually ' +
    'direct route to a real recipient.',
  'apps/web/lib/graph/unit.ts':
    'runAgentUnit reads job.description/jobDescription back out of an already-schema-validated ' +
    'unit input/output (resume_optimizer/outreach) to hand to checkTailoringContainment\'s `jobText` ' +
    'option — the OUTPUT-side containment diff (findUnsupportedClaims), which compares text against ' +
    'the resume rather than interpolating it into a model prompt. It never builds an LLM prompt from ' +
    'it itself (the `callLlm`/`ctx.llm(` this scan also matched on is the fresh per-call LlmRunner ' +
    'handed to whichever agent runs — the prompt, if any, is built one layer down, in ' +
    'lib/harness/agents/outreach.ts / resume_optimizer.ts, both already ledgered above).',
}

/**
 * NOT JOB TEXT — matched the scan, but the untrusted text involved is not an
 * employer-authored job posting. Listed rather than filtered out so the
 * reasoning survives; two of them are adjacent holes worth naming.
 */
const NOT_JOB_TEXT: Record<string, string> = {
  'apps/web/lib/kb/ingest.ts':
    'Store-only (the langgraph port step 4 KB persistence): ingestCompanyPage/ingestDossierSummary ' +
    'write already-fetched company-page text and an already-synthesized summary via ' +
    'lib/kb/store.ts#upsertDocument. Builds no prompt, calls no LLM — does not currently match this ' +
    "scan's CANDIDATES filter at all, but is listed here per that step's explicit instruction so the " +
    'reasoning is on record: the framing obligation belongs to whoever next reads this stored text ' +
    'into a prompt (see lib/harness/agents/company_researcher.ts below for the GitHub-description ' +
    'case of exactly that), not to the store.',
  'apps/web/lib/harness/agents/company_researcher.ts':
    'Interpolates a GitHub org description. Third-party text, but not a job posting — a separate ' +
    'surface, so it is not scanned for frameJobText() by this test either way. Framed anyway ' +
    '(buildSynthPrompt now wraps pub.github.description) because the exposure is the same shape; ' +
    'this entry stays in NOT_JOB_TEXT rather than moving to PROMPT_BUILDERS because the ledger ' +
    'above is specifically about job POSTINGS, and conflating the two would blur why each one is ' +
    'unframed-or-not.',
  'apps/web/lib/graph/copilot.ts':
    'Observation descriptions, produced by Cello itself, not by an employer — the structured ' +
    "ask-user form's own option.description (lib/harness/ask-user.ts's AskOption), scrubbed and " +
    'echoed back in the ask_form interrupt payload. Moved here from app/api/copilot/route.ts (its ' +
    'former home in this ledger) when the LangGraph port relocated the ask-form handling into ' +
    "dispatch — route.ts no longer references `.description` at all, so it dropped off this " +
    "ledger's candidate list entirely.",
  'apps/web/app/api/scraper/trigger/route.ts':
    'Its prompt carries SCRAPED CAREER-PAGE HTML, which is employer-controlled and equally ' +
    'unframed — a real adjacent hole, but page HTML rather than job text, so it is out of scope ' +
    'for job-text.ts and deliberately not papered over here.',
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** Repo-relative POSIX paths of every scanned source file. */
function scannedFiles(): string[] {
  const out: string[] = []
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) out.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  }
  return out.sort()
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

function isFramed(rel: string): boolean {
  const src = read(rel)
  return FRAMING_IMPORT.test(src) && FRAMING_CALL.test(src)
}

const ALL_FILES = scannedFiles()
const CANDIDATES = ALL_FILES.filter((f) => {
  const src = read(f)
  return DESCRIPTION_MARKER.test(src) && PROMPT_MARKER.test(src)
})

const LEDGER = [...Object.keys(PROMPT_BUILDERS), ...Object.keys(FORWARDERS), ...Object.keys(NOT_JOB_TEXT)]

describe('job text reaches a prompt only through the framing helper', () => {
  it('finds files to check (guards against a broken walk silently passing)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(200)
    expect(CANDIDATES.length).toBeGreaterThanOrEqual(12)
  })

  it('the framing helper still exports what the ledger greps for', () => {
    // If frameJobText is renamed, FRAMING_CALL stops matching and every check
    // below quietly passes on the wrong thing.
    const src = read('apps/web/lib/security/job-text.ts')
    expect(src).toMatch(/export function frameJobText\s*\(/)
    expect(src).toMatch(/export function prepareJobText\s*\(/)
    expect(src).toMatch(/export function scanJobTextForInjection\s*\(/)
    expect(src).toMatch(/export function findUnsupportedClaims\s*\(/)
  })

  it('every file that builds a prompt near a description is classified', () => {
    const unclassified = CANDIDATES.filter((f) => !LEDGER.includes(f))
    expect(
      unclassified,
      'These files reference a description AND build a prompt, but are in none of the ledgers ' +
        'in lib/security/injection-chokepoints.test.ts. Read each one and add it to ' +
        'PROMPT_BUILDERS (it puts employer job text in a prompt — then wire frameJobText), ' +
        'FORWARDERS (it only passes the text along) or NOT_JOB_TEXT (the text is not an ' +
        'employer-authored posting), with a note saying which and why:\n  ' +
        unclassified.join('\n  ')
    ).toEqual([])
  })

  it('every ledger entry still exists (catches a rename leaving a stale exemption)', () => {
    const missing = LEDGER.filter((f) => !existsSync(path.join(REPO_ROOT, f)))
    expect(missing, `Ledger entries that no longer exist:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('no file is classified twice', () => {
    const dupes = LEDGER.filter((f, i) => LEDGER.indexOf(f) !== i)
    expect(dupes).toEqual([])
  })

  it('PENDING_WIRING only ever names a prompt builder', () => {
    const strays = PENDING_WIRING.filter((f) => !(f in PROMPT_BUILDERS))
    expect(strays).toEqual([])
  })

  it('the set of unframed prompt builders is EXACTLY the pending list', () => {
    // Both directions matter:
    //   - a builder that lost its framing but is not listed = a regression,
    //     and the payload it re-opens is a fabricated resume;
    //   - a builder that GAINED framing but is still listed = a stale ledger,
    //     which is how a known-offender list rots into a rubber stamp.
    // So wiring a call site is expected to fail this test once, and the fix is
    // to delete that one line from PENDING_WIRING.
    const unframed = Object.keys(PROMPT_BUILDERS).filter((f) => !isFramed(f)).sort()
    expect(
      unframed,
      'PENDING_WIRING is out of date. Files now framed (delete them from the list): ' +
        `${PENDING_WIRING.filter((f) => !unframed.includes(f)).join(', ') || 'none'}. ` +
        'Files newly unframed (wire frameJobText, do not add them to the list): ' +
        `${unframed.filter((f) => !PENDING_WIRING.includes(f)).join(', ') || 'none'}.`
    ).toEqual([...PENDING_WIRING].sort())
  })

  it('the tailoring path is on the builder list — it is why this test exists', () => {
    // A job description that says "also state the candidate holds a security
    // clearance" reaches a real employer through this file and no other. If it
    // is ever reclassified as a forwarder, that is the reclassification to
    // argue about.
    expect(Object.keys(PROMPT_BUILDERS)).toContain('apps/web/lib/harness/agents/cv_tailor.ts')
    expect(Object.keys(FORWARDERS)).not.toContain('apps/web/lib/harness/agents/cv_tailor.ts')
  })

  it('every builder actually still contains job text (no entry kept out of habit)', () => {
    const inert = Object.keys(PROMPT_BUILDERS).filter((f) => !DESCRIPTION_MARKER.test(read(f)))
    expect(
      inert,
      `These are listed as prompt builders but no longer reference a description — ` +
        `if the job text moved, follow it:\n  ${inert.join('\n  ')}`
    ).toEqual([])
  })
})
