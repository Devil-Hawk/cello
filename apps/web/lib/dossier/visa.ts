// Visa / H-1B sponsorship SIGNAL — always `likely | unlikely | unknown`,
// NEVER a hard claim. Two FREE, public inputs, in precedence order:
//
//   1. The company's OWN careers-page text (LLM-parsed, honesty-constrained).
//      A first-party statement wins because "we do sponsor" / "we do not
//      sponsor" is the most direct public evidence.
//   2. A small in-repo list distilled from PUBLIC DoL H-1B LCA disclosure data
//      (employers with a certified-filing track record) -> "likely".
//   3. Otherwise -> "unknown".
//
// The LLM parse only REPORTS what the careers text literally states; it may not
// infer sponsorship from vibes. We never assert a guarantee to the user.

import type { LlmRunner } from '@/lib/harness/types'
import { parseJsonLoose } from '@/lib/harness/llm'
import { composeSystemPrompt, loadModeDoc } from '@/lib/harness/prompts'
import sponsorData from './h1b-sponsors.json'
import type { VisaSignal } from './store'

export type { VisaSignal } from './store'

export interface VisaResult {
  signal: VisaSignal
  /** Where the signal came from (for the UI caveat). */
  source: string
  /** Short verbatim quote / justification, when available. */
  evidence?: string
}

const CURATED = new Set<string>(
  (sponsorData.sponsors as string[]).map((s) => normalizeCompanyName(s))
)

/** Public note explaining what this signal is and is not — surfaced by the
 *  sponsorship API/tooling verbatim so no caller has to re-derive honest
 *  copy (or, worse, quietly drop the caveat and overstate the signal). */
export const SPONSORSHIP_SIGNAL_NOTE =
  'Likely-to-sponsor is a signal from a track record of historical U.S. Department of Labor H-1B LCA ' +
  'filings, never a guarantee for any specific role, team, or year. Companies change sponsorship policy; ' +
  'always confirm directly with the employer before counting on it.'

/**
 * Fold legal-entity suffixes and casing so "Snowflake Inc.", "SNOWFLAKE, INC",
 * and "snowflake" all normalize to the same key as the curated list's plain
 * "snowflake" entry. Order matters: suffix words are stripped from the
 * lowercased-but-still-punctuated string (so "Inc." matches via \binc\b
 * before the "." is stripped), THEN punctuation collapses to spaces.
 */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      // Legal-entity / jurisdiction suffixes ONLY — deliberately excludes
      // semantically-loaded words like "tech", "solutions", "global", or
      // "systems" that are part of a company's actual identity (stripping
      // "tech" would collapse "Tech Mahindra" into "Mahindra", a different,
      // unrelated conglomerate — a false "likely" on the wrong company is
      // exactly the harm this whole signal exists to avoid).
      /\b(inc|incorporated|llc|ltd|limited|plc|corp|corporation|co|company|technologies|technology|labs|laboratories|group|holdings|americas|america|usa|pte|pty|pvt|gmbh)\b/g,
      ''
    )
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Curated public-data match: returns 'likely' or 'unknown' (never 'unlikely'). */
export function visaFromCuratedList(name: string): VisaSignal {
  const norm = normalizeCompanyName(name)
  if (!norm) return 'unknown'
  if (CURATED.has(norm)) return 'likely'
  // Token-containment for multi-word names (e.g. "Google Cloud" -> "google").
  const first = norm.split(' ')[0]
  if (first && first.length >= 3 && CURATED.has(first)) return 'likely'
  return 'unknown'
}

export interface SponsorshipLookup {
  /** The name as given by the caller (not normalized) — echoed back so a
   *  bulk caller can zip results back up against its own input list. */
  name: string
  signal: VisaSignal
  source: string
  /** Always present, always this exact honest caveat — see SPONSORSHIP_SIGNAL_NOTE. */
  note: string
}

/**
 * Zero-LLM-cost sponsorship signal for ONE company name, checked against the
 * curated DoL-derived list ONLY (no careers-page parse — that requires a real
 * LLM call and is the dossier path's job, see resolveVisaSignal). This is the
 * direct entry point resolveVisaSignal was missing: previously the curated
 * list was only ever consulted as a step INSIDE dossier generation, so a
 * company only got a signal once a full dossier had been generated for it —
 * of 449 tracked companies with 3 dossiers, all 3 read 'none'. Any company
 * name can be checked instantly here, dossier or not.
 */
export function sponsorshipSignalForCompany(name: string): SponsorshipLookup {
  const signal = visaFromCuratedList(name)
  return {
    name,
    signal,
    source:
      signal === 'likely'
        ? 'Public U.S. DoL H-1B LCA disclosure track record'
        : 'No public sponsorship signal found (not in the curated DoL-derived list)',
    note: SPONSORSHIP_SIGNAL_NOTE,
  }
}

/** Same lookup, in bulk, preserving input order and duplicates 1:1 with `names`. */
export function sponsorshipSignalForCompanies(names: string[]): SponsorshipLookup[] {
  return names.map(sponsorshipSignalForCompany)
}

/**
 * Parse a careers-page text blob for an explicit sponsorship statement.
 * Returns null when no LLM runner is available (caller falls back to curated).
 */
export async function parseCareersSponsorship(
  careersText: string,
  run: LlmRunner | null,
  signal?: AbortSignal
): Promise<{ signal: VisaSignal; evidence?: string } | null> {
  const text = (careersText || '').trim()
  if (!run || !text) return null
  void signal
  try {
    const res = await run({
      // _shared.md + prompts/visa.md (the house-style mode document — see
      // docs/PROMPT-GENERATOR.md; `_voice.md` is deliberately excluded, since
      // `evidence` is a verbatim quote, not authored prose) is identical for
      // every careers-page parse ever run — the cheapest possible cache
      // prefix to mark.
      system: composeSystemPrompt({ mode: loadModeDoc('visa'), includeVoice: false }),
      prompt: `CAREERS PAGE TEXT:\n${text.slice(0, 6000)}`,
      json: true,
      maxTokens: 300,
      temperature: 0,
      cachePrefix: true,
    })
    const raw = parseJsonLoose<{ signal?: string; evidence?: string }>(res.content)
    const s = raw?.signal
    if (s === 'likely' || s === 'unlikely' || s === 'unknown') {
      return { signal: s, evidence: (raw.evidence || '').trim() || undefined }
    }
    return { signal: 'unknown' }
  } catch {
    return null
  }
}

/**
 * Resolve the final visa signal. Careers-page statement (when definitive) wins;
 * otherwise the curated public-data list; otherwise 'unknown'.
 */
export async function resolveVisaSignal(args: {
  name: string
  careersText?: string
  run?: LlmRunner | null
  signal?: AbortSignal
}): Promise<VisaResult> {
  const curated = visaFromCuratedList(args.name)

  if (args.careersText && args.run) {
    const parsed = await parseCareersSponsorship(args.careersText, args.run, args.signal)
    if (parsed && parsed.signal !== 'unknown') {
      return {
        signal: parsed.signal,
        source: 'Company careers page (first-party statement)',
        evidence: parsed.evidence,
      }
    }
  }

  if (curated === 'likely') {
    return {
      signal: 'likely',
      source: 'Public U.S. DoL H-1B LCA disclosure track record',
    }
  }

  return { signal: 'unknown', source: 'No public sponsorship signal found' }
}
