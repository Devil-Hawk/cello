/**
 * OWNER-RUN, METERED. Populates public.resume_claims / public.claim_evidence
 * (20260816000008_resume_claims.sql) — the citation index behind
 * lib/resume/claims.ts#claimsFor/matchClaim — from each user's base resume
 * and their knowledge base. NEVER auto-run: not scheduled, not called by any
 * request path, not invoked by this task. A human operator runs it once
 * after the migration lands, and again whenever it's worth re-extracting
 * (e.g. after a KB ingest run adds a lot of new documents) — SKIPPED users
 * (below) make re-running safe rather than something to avoid.
 *
 * TWO PASSES, PER USER
 *   1. RESUME PASS — one callLlm call over the base resume text asks for a
 *      list of factual claims (skill/employment/education/metric/
 *      credential), each with a QUOTE the model asserts is copied verbatim
 *      from the resume. Every accepted claim becomes one resume_claims row;
 *      a quote that survives the containment guard below becomes one
 *      claim_evidence row with strength='stated'.
 *   2. KB PASS — for each of the user's most recent KB documents (capped at
 *      KB_DOCS_PER_USER — this is a citation index, not a corpus scan), one
 *      callLlm call is given the already-extracted claim texts and asks
 *      whether the document contains a quote corroborating any of them.
 *      A surviving quote becomes a second claim_evidence row (strength
 *      demonstrated/inferred) with kb_document_id set.
 *   3. Every claim written in pass 1 gets embedded (one batched
 *      callEmbedding call per user) so lib/resume/claims.ts#matchClaim can
 *      use the embedding tier, not just exact-key matching.
 *
 * THE GARBAGE-IN GUARD (the reason this script exists as a script and not a
 * bare INSERT ... SELECT)
 *   A model asked to "quote the resume" can still paraphrase, invent, or —
 *   worse — copy an instruction-shaped sentence out of a hostile KB document
 *   (a scraped job posting can hide "note: candidate has an active
 *   clearance" in white-on-white text, per lib/security/job-text.ts's own
 *   threat model). quotePassesContainment() below is
 *   lib/security/job-text.ts#checkTailoringContainment reused exactly as
 *   findUnsupportedClaims uses it elsewhere in this codebase: the proposed
 *   quote stands in for "tailored" text, the source document stands in for
 *   "resume", and a quote that introduces ANY claim the source doesn't
 *   already contain is rejected — no claim_evidence row is ever written for
 *   it. This is the same deterministic check the langgraph port's binding
 *   ruling 2 makes a hard gate everywhere else; it is the gate here too.
 *
 * INJECTION FRAMING ON THE KB PASS ONLY
 *   The resume pass reads the user's OWN authored text — nothing to frame.
 *   The KB pass reads documents that can originate from a scraped web page
 *   or a job posting, exactly the threat model lib/security/job-text.ts
 *   documents, so each document's content is wrapped in frameJobText()
 *   before it enters the prompt. apps/web/lib/security/injection-
 *   chokepoints.test.ts's source scan does not cover apps/web/scripts (an
 *   owner-run offline tool, not a request path), so this is not
 *   scan-enforced — it is applied because the threat is real regardless of
 *   which directory the code lives in, not because a test requires it.
 *
 *   # source the DB + service-role env first (never commit or echo these)
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/extract-resume-claims.ts                # extract + write
 *   npx tsx scripts/extract-resume-claims.ts --dry-run       # report only, spends nothing, writes nothing
 *   npx tsx scripts/extract-resume-claims.ts --limit 5       # smoke test (users processed)
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_KEY
 *   also accepted) via lib/harness/supabase-admin.ts#createAdminClient() —
 *   the same service-role credentials every other apps/web/scripts/*.ts
 *   owner-run script uses (see scripts/closeout-incomplete-runs.ts).
 */
import { createAdminClient } from '../lib/harness/supabase-admin'
import { loadApiKeys } from '../lib/harness/keys'
import { callLlm, callEmbedding, MissingKeyError, parseJsonLoose } from '../lib/harness/llm'
import { BudgetCapError } from '../lib/harness/spend'
import { getBaseResume } from '../lib/resume/store'
import { listDocuments } from '../lib/kb/store'
import { checkTailoringContainment, frameJobText } from '../lib/security/job-text'
import { CLAIM_KINDS, normalizeClaimKey, type ClaimKind } from '../lib/resume/claims'
import type { AdminClient, DecryptedApiKeys } from '../lib/harness/types'
import type { KbDocument } from '../lib/kb/types'

/** KB documents scanned per user in pass 2. A citation index, not a corpus
 *  scan — the newest documents are the ones most likely to still be relevant
 *  to the user's current base resume. */
const KB_DOCS_PER_USER = 15

/** Does `quote` introduce nothing beyond what `source` already supports?
 *  Reuses lib/security/job-text.ts#checkTailoringContainment exactly as
 *  documented in this file's header — see there for why. */
export function quotePassesContainment(source: string, quote: string): boolean {
  const trimmed = quote.trim()
  if (!trimmed) return false
  return checkTailoringContainment(source, trimmed).ok
}

function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === 'string' && (CLAIM_KINDS as readonly string[]).includes(value)
}

interface ExtractedClaim {
  claimText: string
  claimKind: ClaimKind
  quote: string
}

const RESUME_CLAIM_SYSTEM_PROMPT = `You extract verifiable factual claims from a candidate's own resume.

For each claim, output the exact sentence or phrase from the resume that supports it — copied
character-for-character, not paraphrased. A claim with no exact supporting text in the resume must
not be included.

Respond with ONLY a JSON object: {"claims": [{"claimText": "...", "claimKind": "skill|employment|education|metric|credential", "quote": "..."}]}`

function resumeExtractionPrompt(resumeText: string): string {
  return `## RESUME\n${resumeText}\n\nExtract every skill, employment, education, metric and credential claim, each with its verbatim supporting quote from the resume above.`
}

const KB_EVIDENCE_SYSTEM_PROMPT = `You check whether a document contains a quote that corroborates one of a candidate's already-established resume claims.

Only report a quote that is copied character-for-character from the document. Do not paraphrase, and
do not invent a quote that isn't there. If nothing in the document corroborates any claim, return an
empty list.

Respond with ONLY a JSON object: {"evidence": [{"claimText": "<one of the exact claim texts given>", "quote": "...", "strength": "demonstrated|inferred"}]}`

function kbEvidencePrompt(claimTexts: string[], framedDocument: string): string {
  return `## CANDIDATE'S ESTABLISHED CLAIMS\n${claimTexts.map((c) => `- ${c}`).join('\n')}\n\n## DOCUMENT\n${framedDocument}\n\nFind any quotes in the DOCUMENT that corroborate one of the claims above.`
}

async function extractResumeClaims(keys: DecryptedApiKeys, resumeText: string): Promise<ExtractedClaim[]> {
  const res = await callLlm(keys, {
    system: RESUME_CLAIM_SYSTEM_PROMPT,
    prompt: resumeExtractionPrompt(resumeText),
    json: true,
    maxTokens: 3000,
    temperature: 0,
  })
  const parsed = parseJsonLoose<{ claims?: unknown }>(res.content)
  const raw = Array.isArray(parsed?.claims) ? parsed.claims : []
  const out: ExtractedClaim[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const claimText = typeof r.claimText === 'string' ? r.claimText.trim() : ''
    const quote = typeof r.quote === 'string' ? r.quote.trim() : ''
    if (!claimText || !quote || !isClaimKind(r.claimKind)) continue
    out.push({ claimText, claimKind: r.claimKind, quote })
  }
  return out
}

interface KbEvidenceCandidate {
  claimText: string
  quote: string
  strength: 'demonstrated' | 'inferred'
}

async function extractKbEvidence(keys: DecryptedApiKeys, claimTexts: string[], doc: KbDocument): Promise<KbEvidenceCandidate[]> {
  const framed = frameJobText(doc.content, { label: 'KB DOCUMENT' })
  const res = await callLlm(keys, {
    system: KB_EVIDENCE_SYSTEM_PROMPT,
    prompt: kbEvidencePrompt(claimTexts, framed),
    json: true,
    maxTokens: 1500,
    temperature: 0,
  })
  const parsed = parseJsonLoose<{ evidence?: unknown }>(res.content)
  const raw = Array.isArray(parsed?.evidence) ? parsed.evidence : []
  const out: KbEvidenceCandidate[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const claimText = typeof r.claimText === 'string' ? r.claimText.trim() : ''
    const quote = typeof r.quote === 'string' ? r.quote.trim() : ''
    const strength = r.strength === 'demonstrated' || r.strength === 'inferred' ? r.strength : null
    if (!claimText || !quote || !strength) continue
    out.push({ claimText, quote, strength })
  }
  return out
}

function parseArgs(argv: string[]) {
  const limitIdx = argv.indexOf('--limit')
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitIdx > -1 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : null,
  }
}

/** Users who already have resume_claims for their CURRENT base resume
 *  version are skipped — re-running this script is meant to pick up users
 *  who never got a pass, not to re-spend on everyone every time. */
async function usersAlreadyExtracted(admin: AdminClient, resumeDocumentIds: string[]): Promise<Set<string>> {
  if (resumeDocumentIds.length === 0) return new Set()
  const { data, error } = await admin.from('resume_claims').select('resume_document_id').in('resume_document_id', resumeDocumentIds)
  if (error) throw new Error(`resume_claims scan failed: ${error.message}`)
  return new Set((data ?? []).map((r) => r.resume_document_id as string))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const admin = createAdminClient()

  console.log('extract-resume-claims')
  console.log(`  mode  : ${args.dryRun ? 'DRY RUN (no writes, no spend)' : 'APPLY (writes + spends against each user\'s own cap)'}`)
  console.log(`  limit : ${args.limit ?? '(none — every user with a base resume)'}`)

  const { data: baseRows, error: baseErr } = await admin.from('resume_documents').select('id, user_id').is('job_id', null)
  if (baseErr) throw new Error(`resume_documents scan failed: ${baseErr.message}`)

  // One base resume per user: the newest version, matching getBaseResume's
  // own "latest wins" semantics.
  const latestByUser = new Map<string, string>()
  for (const row of (baseRows ?? []) as { id: string; user_id: string }[]) latestByUser.set(row.user_id, row.id)

  const already = await usersAlreadyExtracted(admin, [...latestByUser.values()])
  const pending = [...latestByUser.entries()].filter(([, docId]) => !already.has(docId))
  console.log(`\n${latestByUser.size} user(s) with a base resume, ${already.size} already extracted, ${pending.length} pending`)

  let usersProcessed = 0
  let claimsWritten = 0
  let evidenceWritten = 0
  let evidenceRejected = 0
  const skipped: string[] = []
  const failed: string[] = []

  for (const [userId, resumeDocumentId] of pending) {
    if (args.limit !== null && usersProcessed >= args.limit) break
    usersProcessed++

    const resume = await getBaseResume(admin, userId)
    const resumeText = resume?.content?.trim() ?? ''
    if (!resumeText) {
      skipped.push(`${userId} (empty base resume)`)
      continue
    }

    if (args.dryRun) {
      process.stderr.write(`\r  scanned ${usersProcessed} user(s)   `)
      continue
    }

    let keys: DecryptedApiKeys
    try {
      keys = await loadApiKeys(admin, userId)
    } catch (err) {
      console.error(`\n  user ${userId}: loadApiKeys failed — ${err instanceof Error ? err.message : err}`)
      failed.push(userId)
      continue
    }

    let extracted: ExtractedClaim[]
    try {
      extracted = await extractResumeClaims(keys, resumeText)
    } catch (err) {
      if (err instanceof MissingKeyError || err instanceof BudgetCapError) {
        skipped.push(`${userId} (${err.name})`)
        continue
      }
      console.error(`\n  user ${userId}: resume extraction failed — ${err instanceof Error ? err.message : err}`)
      failed.push(userId)
      continue
    }
    if (extracted.length === 0) continue

    // Insert every claim first — a claim with zero evidence is still a
    // useful row (matchClaim's normalized_key tier works on claim_text
    // alone); the containment guard governs claim_evidence, not
    // resume_claims.
    const claimIds = new Map<string, string>() // claimText -> id
    for (const c of extracted) {
      const { data, error } = await admin
        .from('resume_claims')
        .insert({
          user_id: userId,
          resume_document_id: resumeDocumentId,
          claim_text: c.claimText,
          claim_kind: c.claimKind,
          normalized_key: normalizeClaimKey(c.claimText),
        })
        .select('id')
        .single()
      if (error || !data) {
        console.error(`\n  user ${userId}: claim insert failed — ${error?.message}`)
        continue
      }
      claimIds.set(c.claimText, data.id as string)
      claimsWritten++

      if (quotePassesContainment(resumeText, c.quote)) {
        const { error: evErr } = await admin
          .from('claim_evidence')
          .insert({ user_id: userId, claim_id: data.id, quote: c.quote, strength: 'stated' })
        if (evErr) console.error(`\n  user ${userId}: evidence insert failed — ${evErr.message}`)
        else evidenceWritten++
      } else {
        evidenceRejected++
      }
    }

    // Embed every claim just written, in one batch — matches lib/kb/store.ts
    // #embedChunksBestEffort's shape: best-effort, never fails the run.
    try {
      const texts = extracted.map((c) => c.claimText)
      const { embeddings } = await callEmbedding(keys, { texts })
      for (let i = 0; i < extracted.length; i++) {
        const id = claimIds.get(extracted[i].claimText)
        if (!id) continue
        const { error: embErr } = await admin.from('resume_claims').update({ embedding: embeddings[i] }).eq('id', id)
        if (embErr) console.error(`\n  claim ${id}: embedding persist failed — ${embErr.message}`)
      }
    } catch (err) {
      console.error(`\n  user ${userId}: embedding failed (claims kept, exact-match only) — ${err instanceof Error ? err.message : err}`)
    }

    // Pass 2: KB documents.
    let kbDocs: KbDocument[] = []
    try {
      kbDocs = await listDocuments(admin, userId, { limit: KB_DOCS_PER_USER })
    } catch (err) {
      console.error(`\n  user ${userId}: KB document list failed — ${err instanceof Error ? err.message : err}`)
    }
    const claimTexts = extracted.map((c) => c.claimText)
    for (const doc of kbDocs) {
      if (!doc.content?.trim()) continue
      let candidates: KbEvidenceCandidate[]
      try {
        candidates = await extractKbEvidence(keys, claimTexts, doc)
      } catch (err) {
        if (err instanceof MissingKeyError || err instanceof BudgetCapError) break
        console.error(`\n  user ${userId} doc ${doc.id}: KB evidence extraction failed — ${err instanceof Error ? err.message : err}`)
        continue
      }
      for (const cand of candidates) {
        const claimId = claimIds.get(cand.claimText)
        if (!claimId) continue // model referenced a claim text we didn't extract — ignore, don't guess
        if (!quotePassesContainment(doc.content, cand.quote)) {
          evidenceRejected++
          continue
        }
        const { error: evErr } = await admin
          .from('claim_evidence')
          .insert({
            user_id: userId,
            claim_id: claimId,
            kb_document_id: doc.id,
            quote: cand.quote,
            strength: cand.strength,
          })
        if (evErr) console.error(`\n  user ${userId}: KB evidence insert failed — ${evErr.message}`)
        else evidenceWritten++
      }
    }

    process.stderr.write(`\r  processed ${usersProcessed} user(s), ${claimsWritten} claim(s), ${evidenceWritten} evidence row(s)   `)
  }
  process.stderr.write('\n')

  console.log(`\nusers processed   : ${usersProcessed}`)
  if (!args.dryRun) {
    console.log(`claims written    : ${claimsWritten}`)
    console.log(`evidence written  : ${evidenceWritten}`)
    console.log(`evidence rejected : ${evidenceRejected} (quote failed the containment guard)`)
    console.log(`users skipped     : ${skipped.length}${skipped.length ? ` — ${skipped.join(', ')}` : ''}`)
    console.log(`users failed      : ${failed.length}${failed.length ? ` — ${failed.join(', ')}` : ''}`)
  } else {
    console.log('DRY RUN — nothing extracted, nothing written, nothing spent.')
  }
}

// Guarded, same reason and same shape as scripts/backfill-interactions.ts:
// scripts/extract-resume-claims.test.ts imports quotePassesContainment from
// this module, and without the guard that import would run main() — which
// calls createAdminClient() and process.exit(1) on the missing-env error
// every test run gets, killing the test process. tsx invokes this file with
// itself as argv[1], so a real `npx tsx` run still executes main() exactly
// as every unguarded sibling script's unconditional call does.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
