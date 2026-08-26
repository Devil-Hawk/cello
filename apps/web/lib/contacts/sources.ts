// Contact sourcing — derive PLAUSIBLE people/contacts at a company for a role,
// working with or without external data sources.
//
// WHAT THIS ACTUALLY SEARCHES, AND WHY THAT LIST GREW
//   The first version of this module searched two things: the job posting's
//   own text and the dossier's synthesized summary, both with regexes. Measured
//   against this workspace's real data (1,000 job rows, 769 companies, 22
//   dossiers) that was almost nothing:
//     - only 11 of 1,000 postings contained ANY email address, and an address
//       was only harvested when its host EXACTLY equalled companies.domain
//     - only 2 of 22 dossiers yielded a candidate, because the dossier never
//       persisted the first-party page text it fetched — only an LLM paragraph.
//       FIXED: lib/harness/agents/company_researcher.ts now persists the raw
//       home/about/careers text via lib/kb/ingest.ts#ingestCompanyPage BEFORE
//       synthesis (and the summary itself via ingestDossierSummary after), so
//       a dossier that has ever been generated leaves the page text on file —
//       see step 1b below, which reads it back via readFreshCompanyPages
//       instead of re-fetching whenever it's on file and under 14 days old.
//     - 323 of 769 companies (42%) have companies.domain = NULL and ~147 more
//       have an AGGREGATOR host stored there (arbeitnow.com, themuse.com,
//       jobs.lever.co), which closes or misdirects every domain-gated path:
//       posting-email attribution, pattern inference, Hunter and Apollo
//     - the posting extractor's precision was ~7%: of 71 candidates it
//       produced, real people were "Rob Cherry, VP of Engineering" and
//       "Dr Ben Warner" while the rest were phrases like "Computer Science",
//       "Data Architecture", "As Manager" and "I'm Allie" — one of which is
//       still sitting in the contacts table as a persisted junk row
//   The user's verdict ("i do not think we're doing ample search") was correct,
//   so the free path now consults, in order:
//     1. the company's OWN public pages (home/about/team/careers/contact) —
//        read back from the KB via lib/kb/ingest.ts#readFreshCompanyPages when
//        a prior dossier run left fresh (<14 days) home/about/careers text on
//        file, otherwise live-fetched via lib/dossier/sources.ts
//        fetchCompanyContactPages — SSRF host-allowlisted to that company's
//        domain, https-only, no redirects off-site, no login, no paid vendor.
//        This is where recruiting addresses actually live.
//     2. the job posting's own text — hiring-manager/recruiter names and
//        recruiting addresses often appear verbatim
//     3. the company dossier (lib/dossier/*, READ-ONLY — this file only reads
//        dossier rows via getDossierByCompany, never writes one), including its
//        news headlines and verified source titles
//     4. the user's OWN contacts whose email is at this company's domain —
//        used ONLY to learn the company's email-address PATTERN from a
//        known-good example, never as a source of new people
//   and it resolves a usable employer domain (dossier official-site source →
//   job posting URL → an address published in the posting) instead of giving
//   up whenever companies.domain is null or points at an aggregator.
//   BYOK providers (Hunter.io, Apollo.io — see ./providers/*) remain pure
//   opt-in enhancements layered on top; with no key configured they are
//   silently skipped and the free path is the entire result.
//
// NEVER A BARE "NOTHING FOUND": every run returns a SearchReport naming each
// source consulted, how much of it was actually looked at, and why it came up
// empty. "No new contacts found — nothing usable" told the user nothing and
// was indistinguishable from a broken button; the report is the fix.
//
// THE CENTRAL RULE, enforced structurally rather than just documented: nothing
// in this file ever sets `verified: true` except a BYOK provider that actually
// ran a deliverability check (Hunter's email-verifier). A name mention, a
// quoted posting email, and a pattern-guessed address are all `verified:
// false` however high their `confidence` — presenting an inferred address as
// confirmed is exactly the product defect this module is designed to avoid.
// Every candidate also carries `basis`, a short human-readable sentence
// explaining HOW it was derived (and, where one exists, `sourceUrl`, the page
// it was read from) — nothing here ever claims a fabricated shared history or
// a connection the candidate cannot actually support, and `emailInferred`
// marks a guessed address as guessed without anyone having to parse prose.
//
// PERSISTENCE NOTE: the `source`/`confidence`/`verified`/`basis` columns on
// public.contacts were added by supabase/migrations/20260728000007_contact_
// provenance.sql, long since applied — this is a required column set for
// every automated write below, not a maybe. A prior version of this file
// probed column availability and, when absent, stuffed provenance into the
// `notes` prose column instead — a queryable column silently regressing to
// unstructured text is worse than a hard error, so that probe is gone. If the
// migration were ever missing, the insert below fails loudly (a real Postgres
// error) rather than quietly writing worse data.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCompanyContactPages, normalizeDomain } from '@/lib/dossier/sources'
import { getDossierByCompany } from '@/lib/dossier/store'
import { readFreshCompanyPages } from '@/lib/kb/ingest'
import { employerDomainFromUrl } from '@/lib/sources/util'
import { looksLikeEmail } from './parse-csv'
import { hunterDomainSearch, hunterEmailFinder, hunterVerifyEmail } from './providers/hunter'
import { apolloPeopleSearch } from './providers/apollo'

// --- Types --------------------------------------------------------------

export type ContactSource = 'dossier' | 'posting' | 'site' | 'pattern' | 'hunter' | 'apollo'

export interface ContactCandidate {
  name: string | null
  email: string | null
  title: string | null
  linkedinUrl: string | null
  source: ContactSource
  /** 0..1 — how much to trust this candidate. Never a hard claim. */
  confidence: number
  /**
   * TRUE only when a provider affirmatively confirmed deliverability. Every
   * other path — including a directly-quoted posting email or a pattern
   * match — is verified=false, however high its confidence.
   */
  verified: boolean
  /** Short, human-readable provenance shown to the user. Never fabricated. */
  basis: string
  /**
   * TRUE when the address was GUESSED (pattern inference) rather than read
   * somewhere. `basis` says so in prose too, but a consumer should never have
   * to parse prose to avoid emailing a made-up address.
   */
  emailInferred?: boolean
  /** The page this candidate was actually read from, when there is one to cite. */
  sourceUrl?: string | null
}

// --- Honest search reporting ----------------------------------------------

export type SearchStepStatus = 'found' | 'empty' | 'skipped' | 'error'

export interface SearchStep {
  /** Stable machine key: posting | dossier | site | existing | pattern | hunter | apollo. */
  key: string
  /** What was consulted, in words a user recognizes. */
  label: string
  status: SearchStepStatus
  /** How much was ACTUALLY looked at — chars scanned, pages fetched, rows read. */
  scanned: string | null
  /** Candidates this step produced. */
  found: number
  /** Why it came up empty, or why it was skipped. Never blank when found === 0. */
  detail: string
}

export interface SearchReport {
  /** One honest sentence a UI can render verbatim in place of "nothing usable". */
  headline: string
  /** Every source consulted this run, in the order it was consulted. */
  steps: SearchStep[]
  /** The domain everything domain-gated was run against, and how we got it. */
  domain: string | null
  domainBasis: string
}

// --- Small text helpers ---------------------------------------------------

/** Trim/collapse a captured title fragment; reject junk that's too short/long. */
function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '')
  if (cleaned.length < 3 || cleaned.length > 60) return null
  // Stored job descriptions are HTML-stripped but not always entity-decoded,
  // so a captured title can end mid-entity ("Talent &amp"). That is a parsing
  // artifact, not a job title.
  if (/&(?:amp|lt|gt|quot|nbsp|#\d+)\b/i.test(cleaned) || /&\s*$/.test(cleaned)) return null
  return cleaned
}

// Common capitalized words that regularly sit where a name would in job-
// posting prose (locations, department names, EEO boilerplate) — a captured
// "name" containing any of these is almost never an actual person.
const NON_NAME_TOKENS = new Set([
  'Team', 'Department', 'Office', 'Company', 'Group', 'Organization', 'Engineering', 'Product', 'Design',
  'Marketing', 'Sales', 'Operations', 'Finance', 'Legal', 'People', 'Talent', 'Recruiting', 'Recruitment',
  'America', 'Europe', 'Asia', 'Remote', 'Hybrid', 'Full', 'Part', 'Time', 'United', 'States', 'Kingdom',
  'City', 'San', 'Francisco', 'New', 'York', 'Los', 'Angeles', 'North', 'South', 'East', 'West', 'Coast',
  'Equal', 'Opportunity', 'Employer', 'Diversity', 'Inclusion', 'Benefits', 'Compensation', 'Base', 'Range',
  'Our', 'The', 'This', 'We', 'You', 'Your',
])

// Abstract nouns that name a FIELD, DEPARTMENT or DISCIPLINE. Measured against
// this workspace's 1,000 real postings, capitalized noun pairs drawn from these
// were the single largest source of fake "people": "Computer Science",
// "Data Architecture", "Spatial Planning", "Customer Success", "Party Payroll
// Integration", "Markets Technology", "Solution Architect". A person's name
// essentially never contains one, so one hit disqualifies the whole capture.
const NON_PERSON_WORD_RE =
  /^(?:science|sciences|scientific|technology|technologies|technical|architecture|architect|architects|planning|integration|integrations|payroll|success|systems?|analytics|security|platforms?|infrastructure|mathematics|statistics|economics|physics|chemistry|biology|administration|management|development|research|operations|solutions?|services?|logistics|manufacturing|healthcare|insurance|banking|retail|media|education|government|defense|energy|transportation|mobility|robotics|automation|intelligence|learning|computing|networks?|cloud|data|software|hardware|digital|business|strategy|consulting|communications|relations|resources|experience|program|project|quality|compliance|governance|risk|audit|procurement|supply|chain|customer|client|account|accounts|partner|vendor|markets?|industry|sector|spatial|environmental|mechanical|electrical|civil|chemical|industrial|aerospace|automotive|telecommunications|pharmaceutical|biotech|fintech|cyber|quantum|blockchain|gaming|hospitality|construction|agriculture|utilities|degree|bachelor|bachelors|master|masters|phd|equivalent|related|field|fields|discipline|disciplines|preferred|required|plus|etc|senior|junior|entry|mid|intern|internship|graduate|apprentice|location|locations|remote|onsite|hybrid|salary|equity|python|java|javascript|typescript|golang|rust|kotlin|swift|react|angular|node|django|kubernetes|docker|aws|azure|gcp)$/i

// First-person/possessive fragments that the capitalized-name regex happily
// swallows out of a recruiter's self-introduction ("Hi, I'm Allie, Head of
// Support"), producing the literal contact name "I'm Allie". The self-intro
// extractor below handles that sentence properly; these tokens must never
// survive as part of a name anywhere else.
const PRONOUN_TOKEN_RE = /^(?:I|I['’]m|Im|I['’]ve|We|We['’]re|They|He|She|It|My|Our|Their|His|Her|Its|Hi|Hey|Hello)$/i

/** Honorifics that legitimately lead a name and shouldn't count toward its token budget. */
const HONORIFIC_RE = /^(?:Dr|Dr\.|Mr|Mr\.|Ms|Ms\.|Mrs|Mrs\.|Prof|Prof\.|Sir|Rev)$/i

// Press-release verbs and corporate suffixes that show up Title-Cased in the
// headlines a company puts on its own home page ("Distyl AI, founded by
// Ex-Palantir, Raises $20M"), where the "founded by" trigger would otherwise
// capture "Ex-Palantir Raises" as a person.
const HEADLINE_WORD_RE =
  /^(?:raises?|raised|launches|launched|announces|announced|joins|joined|names|named|appoints|appointed|hires|hired|backs|backed|secures|secured|closes|closed|expands|expanded|partners|acquires|acquired|wins|won|series|million|billion|funding|round|today|now|inc|inc\.|llc|ltd|gmbh|corp|corp\.|holdings|labs|studio|ventures|capital)$/i

/** "Ex-Palantir", "Co-Lead", "Non-Technical" — a compound modifier, never a surname. */
const MODIFIER_PREFIX_RE = /^(?:ex|co|non|pre|post|anti|sub|re|multi|inter|intra|semi|self|all|top)-/i

const ROLE_HINT_RE =
  /\b(manager|managers|director|directors|lead|leads|head|heads|officer|officers|president|founder|founders|ceo|cto|coo|cfo|cro|cmo|cpo|vp|svp|evp|vice president|engineer(?:s|ing)?|recruiter|recruiters|recruiting|talent|human resources|chief|hiring|partner|principal|architect|architects|scientist|scientists|designer|designers|analyst|analysts|counsel|controller|chair|executive|executives|associate|associates|specialist|specialists|coordinator|representative|consultant|advisor|strategist|administrator|supervisor|technician|developer|developers)\b/i

/**
 * A person's name must not itself read like a job title or a field of study.
 * `allowSingleToken` is true ONLY for the self-introduction path ("I'm Allie,
 * Head of Support at Ashby"), where one capitalized first name plus an
 * explicit role IS the whole, real signal.
 */
function isPlausiblePersonName(name: string, allowSingleToken = false): boolean {
  const all = name.split(/\s+/).filter(Boolean)
  if (all.some((t) => PRONOUN_TOKEN_RE.test(t))) return false
  // An honorific is part of the name but doesn't count toward the 2..3 real
  // tokens ("Dr Ben Warner" is a two-token name wearing a title).
  const tokens = all.filter((t) => !HONORIFIC_RE.test(t))
  const min = allowSingleToken ? 1 : 2
  if (tokens.length < min || tokens.length > 3) return false
  if (tokens.some((t) => NON_NAME_TOKENS.has(t))) return false
  if (tokens.some((t) => NON_PERSON_WORD_RE.test(t))) return false
  if (tokens.some((t) => HEADLINE_WORD_RE.test(t))) return false
  if (tokens.some((t) => MODIFIER_PREFIX_RE.test(t))) return false
  if (tokens.some((t) => t.length < 2)) return false
  // "Senior Software Engineer", "As Manager", "Chief Technology Officers" —
  // a capture containing a role word is the ROLE, not the person holding it.
  if (ROLE_HINT_RE.test(tokens.join(' '))) return false
  return true
}

/**
 * Is this captured fragment usable as a job title for ONE person?
 *
 * Plural role nouns ("Chief Data Officers", "Engineering/IT Leaders") address
 * an audience, not an individual, and a bare department name ("Engineering",
 * "Data Engineering") is a team, not a title — both were prolific false
 * positives in the measured corpus.
 */
const PLURAL_ROLE_TAIL_RE =
  /\b(?:officers|managers|engineers|leaders|directors|executives|architects|specialists|recruiters|founders|heads|presidents|partners|scientists|analysts|designers|developers|consultants|professionals|candidates|applicants)\s*$/i
const BARE_DEPARTMENT_RE =
  /^(?:data\s+)?(?:engineering|product|design|marketing|sales|operations|finance|legal|people|talent|recruiting|research|security|support|success|analytics|science|technology)$/i

function isSingularPersonTitle(title: string): boolean {
  if (PLURAL_ROLE_TAIL_RE.test(title)) return false
  if (BARE_DEPARTMENT_RE.test(title.trim())) return false
  // A job title LEADS with the role ("VP of Engineering", "Head of Support at
  // Ashby", "one of the co-founders here"). When the role word only shows up
  // late, the capture has run on through something else first — a team-page
  // grid collapsed to one line gives "Brunei Dace Willmott Software Engineer
  // New York", where the "title" starts with a city and a different person's
  // name. Four words of slack keeps the honest phrasings above.
  const head = title.trim().split(/\s+/).slice(0, 4).join(' ')
  return ROLE_HINT_RE.test(head)
}

// Intra-name separators are SPACES AND TABS, never `\s` — `\s` crosses line
// breaks, so "Dina Hussain\n\nLocation: Remote" parsed as the three-token name
// "Dina Hussain Location". A person's given and family names sit on one line.
const NAME_ONLY_RE = /^\s*((?:(?:Dr|Mr|Ms|Mrs|Prof)\.?[ \t]+)?[A-Z][a-zA-Z'’.-]+(?:[ \t]+[A-Z][a-zA-Z'’.-]+){1,2})/
const TITLE_TAIL_RE = /^\s*,\s*(?:our|the)?\s*([A-Za-z][\w /&-]{2,50}?)(?=[.,;\n]|$)/

/**
 * The name character class has to admit "." so that "Dr." and the initial in
 * "J. Smith" survive — which also means a sentence-ending period rides along
 * ("...is Dina Hussain." captured the contact name "Dina Hussain."). Strip a
 * trailing dot only when the last token is long enough to not be an initial.
 */
function normalizeCapturedName(raw: string): string {
  const name = raw.trim().replace(/[,;:'’-]+$/, '')
  const tokens = name.split(/\s+/)
  const last = tokens[tokens.length - 1] ?? ''
  if (last.endsWith('.') && last.replace(/\.+$/, '').length > 1) {
    tokens[tokens.length - 1] = last.replace(/\.+$/, '')
    return tokens.join(' ')
  }
  return name
}

/** Given text starting right after a trigger keyword, pull a name + optional trailing title. */
function matchNameAndOptionalTitle(windowText: string): { name: string; title: string | null } | null {
  const nm = NAME_ONLY_RE.exec(windowText)
  if (!nm) return null
  const name = normalizeCapturedName(nm[1])
  let title: string | null = null
  const rest = windowText.slice(nm[0].length)
  const tm = TITLE_TAIL_RE.exec(rest)
  if (tm) title = cleanTitle(tm[1])
  return { name, title }
}

interface KeywordMentionSpec {
  keywords: string[]
  defaultTitle: string | null
  confidence: number
}

// Case-insensitive keyword lookup done via string search (not a regex /i/
// flag) so the CAPITALIZATION requirement inside NAME_ONLY_RE never gets
// silently defeated by the flag applying to the whole pattern.
const KEYWORD_MENTIONS: KeywordMentionSpec[] = [
  { keywords: ['reports to', 'report directly to', 'reporting to', 'report to', 'you will report to', 'report into'], defaultTitle: null, confidence: 0.5 },
  { keywords: ['hiring manager is', 'hiring manager:', 'hiring manager -', 'hiring manager for this role is'], defaultTitle: 'Hiring manager', confidence: 0.55 },
  { keywords: ['recruiter is', 'recruiter for this role is', 'recruiter:', 'your recruiter'], defaultTitle: 'Recruiter for this role', confidence: 0.55 },
  { keywords: ['point of contact:', 'point of contact is'], defaultTitle: 'Point of contact', confidence: 0.45 },
  { keywords: ['reach out to', 'get in touch with', 'questions to', 'direct questions to'], defaultTitle: null, confidence: 0.4 },
  { keywords: ['founded by', 'co-founded by', 'started by'], defaultTitle: 'Founder / leadership', confidence: 0.4 },
  { keywords: ['led by', 'is led by', 'team is led by', 'headed by'], defaultTitle: 'Team lead (per posting)', confidence: 0.4 },
  { keywords: ["you'll work with", 'you will work with', 'work closely with', "you'll partner with", 'interview with', 'meet with'], defaultTitle: null, confidence: 0.35 },
  { keywords: ['statement from', 'statement by'], defaultTitle: 'Company spokesperson (per news headline)', confidence: 0.35 },
]

function extractKeywordMentions(text: string): { name: string; title: string | null; confidence: number }[] {
  const lower = text.toLowerCase()
  const out: { name: string; title: string | null; confidence: number }[] = []
  for (const spec of KEYWORD_MENTIONS) {
    for (const kw of spec.keywords) {
      let idx = lower.indexOf(kw)
      while (idx !== -1) {
        const start = idx + kw.length
        const window = text.slice(start, start + 90)
        const hit = matchNameAndOptionalTitle(window)
        if (hit) out.push({ name: hit.name, title: hit.title ?? spec.defaultTitle, confidence: spec.confidence })
        idx = lower.indexOf(kw, idx + kw.length)
      }
    }
  }
  return out
}

// "Hi, I'm Allie, Head of Support at Ashby" — the single most common way a
// real, named human appears in a job posting, and the one the generic
// name-then-title pattern mangled into the contact "I'm Allie". A first name
// alone is enough here BECAUSE the sentence explicitly attaches a role: the
// person is real and cited, we just only know what they chose to publish.
const SELF_INTRO_RE =
  /\b(?:I['’]m|I am|My name is|This is)[ \t]+((?:[A-Z][a-zA-Z'’.-]+)(?:[ \t]+[A-Z][a-zA-Z'’.-]+){0,2})[ \t]*,[ \t]*(?:the |a |an |our )?([A-Za-z][\w /&-]{2,50}?)(?=[.,;\n]|$)/g

function extractSelfIntros(text: string): { name: string; title: string | null; confidence: number; single: true }[] {
  const out: { name: string; title: string | null; confidence: number; single: true }[] = []
  SELF_INTRO_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SELF_INTRO_RE.exec(text))) {
    const title = cleanTitle(m[2])
    if (!title || !isSingularPersonTitle(title)) continue
    out.push({ name: normalizeCapturedName(m[1]), title, confidence: 0.5, single: true })
  }
  return out
}

// "Jane Doe, our Head of Engineering" — name FIRST, title after. Not anchored
// to a keyword, so it is gated three ways: the captured title must read like
// ONE person's role (isSingularPersonTitle), the captured name must not read
// like a role or a field (isPlausiblePersonName), and the phrase must not be
// sitting inside a LIST. The list check is what stops "a degree in Computer
// Science, Engineering, or a related field" from yielding a person named
// "Computer Science" — by far the most common false positive in the corpus.
const NAME_THEN_TITLE_RE =
  /\b([A-Z][a-zA-Z'’.-]+(?:[ \t]+[A-Z][a-zA-Z'’.-]+){1,2}),[ \t]+(?:our|the)?[ \t]*([A-Za-z][\w /&-]{2,50}?)(?=[.,;\n]|$)/g

/** Words that, immediately before a capitalized phrase, mark it as a list item or a subject — not a person being introduced. */
const LIST_LEAD_IN_RE =
  /(?:\b(?:in|of|or|and|degree|degrees|field|fields|major|majors|background|discipline|disciplines|area|areas|including|such as|like|e\.g\.?|i\.e\.?)\s+|[,;/&]\s*)$/i

function extractNameThenTitle(text: string): { name: string; title: string | null; confidence: number }[] {
  const out: { name: string; title: string | null; confidence: number }[] = []
  NAME_THEN_TITLE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NAME_THEN_TITLE_RE.exec(text))) {
    const rawTitle = cleanTitle(m[2])
    if (!rawTitle || !isSingularPersonTitle(rawTitle)) continue
    // Lead-in: "...a degree in Computer Science, Engineering..." — the capture
    // is an item in an enumeration, not somebody's name.
    if (LIST_LEAD_IN_RE.test(text.slice(Math.max(0, m.index - 32), m.index))) continue
    // Trail: "... , Engineering, or a related field" — an explicit or/and
    // continuation after the "title" is the same enumeration seen from the
    // other side. A genuine "Name, Title, and Name, Title" pair loses its
    // second person here; that is the correct trade against inventing one.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16)
    if (/^\s*,?\s*(?:or|and)\s+(?:a\s+|an\s+|the\s+)?[A-Za-z]/i.test(after)) continue
    // "Name, Title, Organisation" — the person works at the org NAMED HERE, not
    // at whatever company's page this text came from.
    //
    // This is the difference between a weak guess and a fabrication. A company
    // page quoting "Dax Dasilva, Founder and CEO, Lightspeed" would otherwise
    // yield a contact called Dax Dasilva attributed to the page's owner — and
    // because the caller synthesizes an address from the COMPANY's domain, that
    // invented pairing ends up one click from an outreach email. Sending a real
    // person's name at an employer they have never worked for is the worst
    // failure this module can produce, so an employer attribution we cannot
    // resolve means we drop the candidate rather than guess.
    //
    // A trailing capitalized token that is a sentence continuation ("…, Head of
    // Engineering, joined us in 2020") does not match, because continuations
    // start lowercase. Place names ("…, London") do match and are dropped: an
    // over-rejection here costs one weak lead, an under-rejection costs trust.
    const trailer = text.slice(m.index + m[0].length, m.index + m[0].length + 64)
    if (/^\s*,\s*(?:at\s+|@\s*)?[A-Z][\w&'’.-]*(?:[ \t]+[A-Z][\w&'’.-]*){0,3}\s*(?:[.,;)\n]|$)/.test(trailer)) {
      continue
    }
    out.push({ name: normalizeCapturedName(m[1]), title: rawTitle, confidence: 0.45 })
  }
  return out
}

// Postings are stored HTML-stripped and truncated by the source adapters
// (lib/sources/util.ts truncate(), 4k default) but the longest real rows in
// this workspace run to ~19k chars, so the old 8k scan window silently ignored
// the back half of the longest postings — which is exactly where "questions?
// email ..." tends to live.
const MAX_SCAN_CHARS = 20_000

/**
 * Best-effort, deliberately conservative name/title extraction from free-form
 * prose (dossier text, a job posting, or a company's own page). Heuristic and
 * low-confidence by design — every hit is capped well below anything a
 * provider or a directly-quoted email earns, and the name/title gates above
 * throw out the location/department/field-of-study/EEO-boilerplate false
 * positives that made the first version of this untrustworthy.
 */
function extractNamedMentions(
  text: string,
  source: 'dossier' | 'posting' | 'site',
  sourceUrl: string | null = null
): ContactCandidate[] {
  if (!text || !text.trim()) return []
  const clipped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const raw: { name: string; title: string | null; confidence: number; single?: boolean }[] = [
    ...extractSelfIntros(clipped),
    ...extractKeywordMentions(clipped),
    ...extractNameThenTitle(clipped),
  ]
  const where =
    source === 'dossier' ? 'the company dossier' : source === 'site' ? `${sourceUrl ?? 'the company website'}` : 'the job posting'
  const out: ContactCandidate[] = []
  for (const hit of raw) {
    if (!isPlausiblePersonName(hit.name, hit.single === true)) continue
    out.push({
      name: hit.name,
      email: null,
      title: hit.title,
      linkedinUrl: null,
      source,
      confidence: hit.confidence,
      verified: false,
      sourceUrl,
      basis:
        `INFERRED from ${where} — a name mention near ` +
        `${hit.title ? `"${hit.title}"` : 'a contact/leadership reference'}, not independently confirmed.`,
    })
  }
  return dedupeCandidates(out)
}

// --- Email extraction ------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// Recruiting-flavored role aliases: not a named individual, but a real,
// useful outreach channel — surfaced as a general contact, never as a person.
const GENERAL_ALIASES = new Set(['careers', 'career', 'recruiting', 'recruitment', 'talent', 'hiring', 'jobs', 'apply', 'people', 'hr', 'team', 'work', 'join'])
// Role aliases that are NOT relevant to job outreach (ADA/legal/support/etc.)
// — excluded outright rather than surfaced as noise.
const EXCLUDED_ALIASES = new Set([
  'accommodations', 'ada', 'accessibility', 'privacy', 'legal', 'security', 'abuse', 'support', 'billing',
  'press', 'media', 'info', 'admin', 'noreply', 'no-reply', 'webmaster', 'postmaster', 'unsubscribe', 'help',
  'contact', 'sales', 'marketing', 'hello', 'compliance', 'trust', 'safety', 'dpo', 'gdpr', 'finance',
])
// "jane.doe" / "j.doe" / "jane_doe" — looks like it maps to a real name.
const PERSON_LOCAL_RE = /^[a-z]+([._-][a-z]+)+$/

// Hosts that are NEVER the employer even when they appear in the employer's
// own posting: aggregators, ATS vendors, and consumer mail providers. This
// SUPPLEMENTS lib/sources/util.ts employerDomainFromUrl (which owns the
// canonical aggregator list) with the ATS/free-mail hosts that matter
// specifically when deciding whether an address belongs to a company.
const NEVER_EMPLOYER_HOSTS = new Set([
  'workable.com', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com', 'bamboohr.com', 'jazzhr.com',
  'recruitee.com', 'teamtailor.com', 'breezy.hr', 'personio.de', 'join.com', 'indeed.com', 'glassdoor.com',
  'ziprecruiter.com', 'wellfound.com', 'angel.co', 'builtin.com', 'dice.com', 'monster.com', 'jobvite.com',
  'icims.com', 'taleo.net', 'successfactors.com', 'greenhouse.io', 'lever.co', 'ashbyhq.com',
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com',
  'aol.com', 'gmx.de', 'web.de', 'example.com', 'sentry.io', 'wordpress.com',
])

function isNeverEmployerHost(host: string): boolean {
  if (NEVER_EMPLOYER_HOSTS.has(host)) return true
  for (const bad of NEVER_EMPLOYER_HOSTS) {
    if (host.endsWith(`.${bad}`)) return true
  }
  // employerDomainFromUrl owns the aggregator list; reuse it rather than fork it.
  return employerDomainFromUrl(`https://${host}`) === null
}

/** True when `emailHost` is the company's domain or a subdomain of it (careers.acme.com counts; notacme.com does not). */
function hostBelongsToDomain(emailHost: string | null, companyHost: string): boolean {
  if (!emailHost) return false
  return emailHost === companyHost || emailHost.endsWith(`.${companyHost}`) || companyHost.endsWith(`.${emailHost}`)
}

function classifyEmailLocal(
  email: string
): { kind: 'person' | 'general'; displayName: string | null; title: string | null; confidence: number } | null {
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  const base = local.split('+')[0] // strip a +tag suffix (e.g. talent+hn)
  if (EXCLUDED_ALIASES.has(base)) return null
  if (GENERAL_ALIASES.has(base)) {
    return { kind: 'general', displayName: null, title: 'General recruiting/company contact', confidence: 0.55 }
  }
  if (PERSON_LOCAL_RE.test(base)) {
    const name = base
      .split(/[._-]/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join(' ')
    return { kind: 'person', displayName: name || null, title: null, confidence: 0.7 }
  }
  return null // an ambiguous single-word alias not on either list — skip rather than guess
}

/**
 * Every address published in a block of text that could plausibly belong to
 * this company.
 *
 * Address SHAPE is validated with looksLikeEmail (lib/contacts/parse-csv.ts) —
 * the same gate the CSV importer uses to refuse mailing "Jane" — rather than
 * trusting the extraction regex alone.
 *
 * When the company's domain is known, an address on it (or a subdomain of it)
 * is a strong hit. When it ISN'T known — true for 42% of companies here —
 * refusing to look was the old behaviour and it found nothing; instead the
 * address is still surfaced, at markedly lower confidence and with a basis
 * that says outright that the domain was never confirmed. Aggregator, ATS and
 * consumer-mail hosts are dropped either way: those are provably not the
 * employer, so attributing them would be the fabrication this module forbids.
 */
function extractEmails(
  text: string,
  companyHost: string | null,
  source: 'posting' | 'site' | 'dossier',
  sourceUrl: string | null = null
): ContactCandidate[] {
  if (!text) return []
  const clipped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const out: ContactCandidate[] = []
  const seen = new Set<string>()
  const where = source === 'site' ? (sourceUrl ?? 'the company website') : source === 'dossier' ? 'the company dossier' : 'the job posting'

  for (const m of clipped.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase().replace(/[.,;:]+$/, '')
    if (seen.has(email)) continue
    seen.add(email)
    if (!looksLikeEmail(email)) continue
    const emailHost = normalizeDomain(email.split('@')[1] ?? null)
    if (!emailHost) continue

    const onCompanyDomain = companyHost ? hostBelongsToDomain(emailHost, companyHost) : false
    if (!onCompanyDomain) {
      // Never attribute a third-party address to this company.
      if (companyHost) continue
      if (isNeverEmployerHost(emailHost)) continue
    }

    const classified = classifyEmailLocal(email)
    if (!classified) continue
    const confidence = onCompanyDomain ? classified.confidence : Math.min(classified.confidence, 0.35)
    out.push({
      name: classified.displayName,
      email,
      title: classified.title,
      linkedinUrl: null,
      source,
      confidence,
      verified: false,
      sourceUrl,
      basis: onCompanyDomain
        ? classified.kind === 'person'
          ? `Email address published directly in ${where} at ${emailHost} — the address itself is real, but who it belongs to is a guess from the local part.`
          : `General recruiting/company inbox published directly in ${where} at ${emailHost}.`
        : `Email address published directly in ${where}, at ${emailHost}. This company has no confirmed domain on file, so we could NOT confirm the address belongs to them — check before using it.`,
    })
  }
  return out
}

/** Named mentions + published, domain-plausible email addresses from one job posting's text. */
export function extractPostingCandidates(text: string, domain: string | null): ContactCandidate[] {
  if (!text) return []
  const host = normalizeDomain(domain)
  return dedupeCandidates([...extractNamedMentions(text, 'posting'), ...extractEmails(text, host, 'posting')])
}

/** Named mentions + published addresses from one of the company's OWN public pages. */
export function extractSiteCandidates(page: { url: string; text: string }, domain: string | null): ContactCandidate[] {
  const host = normalizeDomain(domain)
  return dedupeCandidates([
    ...extractNamedMentions(page.text, 'site', page.url),
    ...extractEmails(page.text, host, 'site', page.url),
  ])
}

// --- Dossier text extraction -----------------------------------------------

export interface DossierTextInput {
  summary?: string | null
  culture?: string | null
  whatTheyWant?: string | null
  funding?: string | null
  headcountTrend?: string | null
  /** dossier.sources[].title — news headlines etc. sometimes name a person. */
  sourceTitles?: string[]
  /** signals.raw.* free text kept for the no-LLM path (GitHub org description, Wikipedia extract). */
  rawText?: string[]
}

/** Named mentions from the company dossier's synthesized text + source headlines. Never touches the dossier row. */
export function extractDossierCandidates(input: DossierTextInput): ContactCandidate[] {
  const blocks = [
    input.summary,
    input.culture,
    input.whatTheyWant,
    input.funding,
    input.headcountTrend,
    ...(input.sourceTitles ?? []),
    ...(input.rawText ?? []),
  ].filter((s): s is string => !!s && s.trim().length > 0)
  const out: ContactCandidate[] = []
  for (const block of blocks) out.push(...extractNamedMentions(block, 'dossier'))
  return dedupeCandidates(out)
}

// --- Pattern inference -------------------------------------------------------

export interface KnownGoodContact {
  name: string
  email: string
}

interface EmailPattern {
  template: string
  domain: string
  exampleEmail: string
}

function tokenizeName(name: string): { first: string; last: string } | null {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => !HONORIFIC_RE.test(p))
    .map((p) => p.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean)
  if (parts.length < 2) return null
  return { first: parts[0], last: parts[parts.length - 1] }
}

/** Compare a known-good (name, email) pair against the common enterprise address templates. */
function detectPattern(name: string, email: string, domain: string): EmailPattern | null {
  const local = email.split('@')[0]?.toLowerCase()
  const emailDomain = normalizeDomain(email.split('@')[1] ?? null)
  if (!local || !emailDomain || emailDomain !== normalizeDomain(domain)) return null
  const tok = tokenizeName(name)
  if (!tok) return null
  const { first, last } = tok
  if (!first || !last) return null
  const fi = first[0]
  const li = last[0]
  const candidates: [string, string][] = [
    [`${first}.${last}`, '{first}.{last}'],
    [`${first}_${last}`, '{first}_{last}'],
    [`${first}${last}`, '{first}{last}'],
    [`${fi}${last}`, '{f}{last}'],
    [`${fi}.${last}`, '{f}.{last}'],
    [`${first}${li}`, '{first}{l}'],
    [`${first}.${li}`, '{first}.{l}'],
    [`${last}.${first}`, '{last}.{first}'],
    [`${last}${first}`, '{last}{first}'],
    [`${fi}${li}`, '{f}{l}'],
    [first, '{first}'],
    [last, '{last}'],
  ]
  for (const [candidate, template] of candidates) {
    if (candidate === local) return { template, domain: emailDomain, exampleEmail: email }
  }
  return null
}

function applyPattern(pattern: EmailPattern, name: string): string | null {
  const tok = tokenizeName(name)
  if (!tok) return null
  const { first, last } = tok
  let local = pattern.template
    .split('{first}').join(first)
    .split('{last}').join(last)
    .split('{f}').join(first[0] ?? '')
    .split('{l}').join(last[0] ?? '')
  local = local.trim()
  if (!local) return null
  const email = `${local}@${pattern.domain}`
  // Shape-check the address we just synthesized with the SAME gate the CSV
  // importer uses (lib/contacts/parse-csv.ts) — a guessed address that isn't
  // even email-shaped must never reach a contacts row.
  return looksLikeEmail(email) ? email : null
}

/**
 * Learn an email-address pattern from ANY known-good (name, email) pair at
 * this domain, then apply it to fill in an address for name-only candidates.
 * Returns [] when no known-good example exists — this module never fabricates
 * a pattern out of thin air, only from real evidence already in the product.
 */
export function inferPatternCandidates(
  nameOnlyCandidates: ContactCandidate[],
  knownGood: KnownGoodContact[],
  domain: string
): ContactCandidate[] {
  const host = normalizeDomain(domain)
  if (!host) return []
  let pattern: EmailPattern | null = null
  for (const kg of knownGood) {
    const p = detectPattern(kg.name, kg.email, host)
    if (p) {
      pattern = p
      break
    }
  }
  if (!pattern) return []
  const out: ContactCandidate[] = []
  for (const cand of nameOnlyCandidates) {
    if (cand.email || !cand.name) continue
    const email = applyPattern(pattern, cand.name)
    if (!email) continue
    out.push({
      ...cand,
      email,
      source: 'pattern',
      confidence: Math.min(cand.confidence, 0.5),
      verified: false,
      emailInferred: true,
      basis:
        `INFERRED, NOT VERIFIED: applied the "${pattern.template}" address pattern (learned from the known-good ` +
        `address ${pattern.exampleEmail}) to ${cand.name}. Confirm before relying on it.`,
    })
  }
  return out
}

// --- Ranking / dedupe ----------------------------------------------------

function rank(c: ContactCandidate): number {
  return (c.verified ? 10 : 0) + c.confidence
}

export function dedupeCandidates(cands: ContactCandidate[]): ContactCandidate[] {
  const byKey = new Map<string, ContactCandidate>()
  for (const c of cands) {
    if (!c.email && !c.name) continue
    const key = c.email ? `email:${c.email.toLowerCase()}` : `name:${(c.name as string).toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing || rank(c) > rank(existing)) byKey.set(key, c)
  }
  return [...byKey.values()]
}

// --- Orchestrator ------------------------------------------------------------

export interface ProviderOutcome {
  provider: 'hunter' | 'apollo'
  ran: boolean
  /** Set whenever ran=false — always a clear, honest reason, never a silent gap. */
  reason?: 'no-key' | 'no-domain' | 'error'
  found: number
}

export interface SourceContactsParams {
  /** Service-role (admin) client — this function explicitly scopes every query by userId itself. */
  client: SupabaseClient
  userId: string
  companyId: string
  /** Scope posting-text extraction to one job; omit to scan the company's most recent postings. */
  jobId?: string | null
  hunterKey?: string | null
  apolloKey?: string | null
  /** Cap on candidates persisted as new contacts rows (default 10, max 25). */
  limit?: number
  /**
   * Fetch the company's own public pages. Default true — it is the highest-
   * yield free source and the reason this feature stopped being theatre. Set
   * false in tests, or anywhere an outbound request is unwelcome.
   */
  fetchSite?: boolean
  signal?: AbortSignal
}

export interface SourceContactsResult {
  companyId: string
  companyName: string
  domain: string | null
  jobId: string | null
  /** Every scored candidate, ranked best-first — ALWAYS carries full provenance, independent of DB migration state. */
  candidates: ContactCandidate[]
  inserted: { id: string; name: string; email: string | null; source: ContactSource }[]
  skippedExisting: number
  providers: ProviderOutcome[]
  freePathOnly: boolean
  /** Always true — provenance columns are a required migration, not a probed maybe. Kept on the shape rather than removed so callers (trail/audit) don't need a matching type change for a value that never varies. */
  provenanceColumnsAvailable: boolean
  /** WHAT WAS SEARCHED and why it produced what it did. Never omitted, especially not on an empty result. */
  search: SearchReport
}

const JOBS_SCAN_LIMIT = 5
const MAX_HUNTER_FINDER_LOOKUPS = 3
const PATTERN_ANCHOR_SCAN_LIMIT = 200

interface CompanyRow {
  id: string
  name: string
  domain: string | null
}
interface ExistingContactRow {
  id: string
  name: string
  email: string | null
  title: string | null
}

/**
 * A stored `companies.domain` is only usable as THE employer domain if it
 * isn't an aggregator/ATS host — 147 of the 769 company rows here have
 * `arbeitnow.com` / `themuse.com` / `jobs.lever.co` sitting in that column,
 * and treating those as the employer's domain would attribute a third party's
 * addresses to the employer.
 *
 * UNLESS the company genuinely IS that vendor: Ashby's own domain really is
 * ashbyhq.com, and refusing it would be its own false negative. The company
 * name matching the domain's first label is the evidence that distinguishes
 * the two cases ("Ashby" ⊂ "ashbyhq" — but "Capital One" ⊄ "themuse").
 */
function usableEmployerDomain(raw: string | null | undefined, companyName?: string): string | null {
  const host = normalizeDomain(raw)
  if (!host) return null
  if (!isNeverEmployerHost(host)) return host
  const label = host.split('.')[0] ?? ''
  const squashed = (companyName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  // Length floor so a 2-3 char name can't collide its way past the denylist.
  if (squashed.length >= 4 && (label.includes(squashed) || squashed.includes(label))) return host
  return null
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** "a, b and c" — the full stop belongs to the caller. */
function joinList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The lead clause of a `detail`, for use inside a parenthetical. Every detail
 * below is written so that everything before the em dash stands on its own as
 * the reason, and everything after it is the "…and here is what to do about
 * it" tail the per-step list shows in full.
 */
function shortDetail(detail: string): string {
  const lead = detail.split(' — ')[0].split(' (')[0]
  return lead.length > 90 ? `${lead.slice(0, 87)}…` : lead
}

/**
 * The sentence(s) a UI shows in place of "No new contacts found — nothing
 * usable". Names what was searched and how much of it was read, then why that
 * came up empty, then what was NOT searched and why. The per-step list carries
 * the full detail; this stays readable.
 */
function buildHeadline(steps: SearchStep[], insertedCount: number, skippedExisting: number): string {
  const consulted = steps.filter((s) => s.status === 'found' || s.status === 'empty' || s.status === 'error')
  const consultedLabels = consulted.map((s) => (s.scanned ? `${s.label} (${s.scanned})` : s.label))
  const skipped = steps.filter((s) => s.status === 'skipped')
  const notSearched =
    skipped.length > 0 ? ` Not searched: ${joinList(skipped.map((s) => `${s.label} (${shortDetail(s.detail)})`))}.` : ''

  if (insertedCount > 0) {
    return (
      `Found ${fmt(insertedCount)} new contact${insertedCount === 1 ? '' : 's'}. Searched ` +
      `${joinList(consultedLabels) || 'the sources available'}.${notSearched}`
    )
  }
  if (skippedExisting > 0) {
    return (
      `No NEW contacts. Searched ${joinList(consultedLabels) || 'the sources available'}; the ` +
      `${fmt(skippedExisting)} match${skippedExisting === 1 ? '' : 'es'} found ${skippedExisting === 1 ? 'is' : 'are'} already on file.${notSearched}`
    )
  }
  if (consulted.length === 0) {
    return `Nothing could be searched for this company.${notSearched || ' No sources were available.'}`
  }
  const failed = consulted.filter((s) => s.status === 'error')
  const why =
    failed.length > 0
      ? `${joinList(failed.map((s) => `${s.label}: ${shortDetail(s.detail)}`))}; nothing else named a person or published an email address`
      : 'none of them named a person or published an email address'
  return `No contacts found. Searched ${joinList(consultedLabels)} — ${why}.${notSearched}`
}

export async function sourceContactsForCompany(params: SourceContactsParams): Promise<SourceContactsResult> {
  const { client, userId, companyId, jobId, hunterKey, apolloKey, signal } = params
  const limit = Math.max(1, Math.min(25, params.limit ?? 10))
  const steps: SearchStep[] = []

  const { data: companyData } = await client
    .from('companies')
    .select('id, name, domain')
    .eq('id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  const company = companyData as CompanyRow | null
  if (!company) throw new Error('Company not found (or not owned by this user)')

  // 1) Posting text — either one specific job, or this company's most recent.
  //    `url` comes along so a missing/aggregator company domain can still be
  //    resolved from where the posting actually lives.
  const postingTexts: { jobId: string; text: string; url: string | null }[] = []
  const postingUrls: string[] = []
  if (jobId) {
    const { data: job } = await client.from('jobs').select('id, description, url, company_id').eq('id', jobId).maybeSingle()
    const j = job as { id: string; description: string | null; url: string | null; company_id: string } | null
    if (j && j.company_id === companyId) {
      if (j.url) postingUrls.push(j.url)
      if (j.description) postingTexts.push({ jobId: j.id, text: j.description, url: j.url })
    }
  } else {
    const { data: jobs } = await client
      .from('jobs')
      .select('id, description, url')
      .eq('company_id', companyId)
      .order('discovered_at', { ascending: false })
      .limit(JOBS_SCAN_LIMIT)
    for (const j of (jobs as { id: string; description: string | null; url: string | null }[] | null) ?? []) {
      if (j.url) postingUrls.push(j.url)
      if (j.description) postingTexts.push({ jobId: j.id, text: j.description, url: j.url })
    }
  }

  // 2) Dossier (READ-ONLY).
  const dossier = await getDossierByCompany(client, userId, companyId)

  // 3) Resolve an employer domain. companies.domain is null for ~42% of rows
  //    here and an aggregator host (arbeitnow.com, themuse.com, jobs.lever.co)
  //    for many of the rest, and EVERY domain-gated path — posting-email
  //    attribution, the site fetch, pattern inference, Hunter, Apollo — was
  //    silently disabled or misdirected by that. Each fallback below is a fact
  //    already recorded in the product, never a guess at a company's domain.
  let domain = usableEmployerDomain(company.domain, company.name)
  let domainBasis = domain ? `companies.domain (${domain})` : ''
  if (!domain) {
    // The dossier's own verified official-site / careers source (the dossier
    // pipeline only records those after confirming the page is the company's).
    const officialSource = (dossier?.sources ?? []).find(
      (s) => s.matchedBy === 'official-site' || s.matchedBy === 'careers'
    )
    const fromDossier = officialSource ? usableEmployerDomain(employerDomainFromUrl(officialSource.url), company.name) : null
    if (fromDossier) {
      domain = fromDossier
      domainBasis = `the dossier's verified official-site source (${officialSource!.url})`
    }
  }
  if (!domain) {
    for (const url of postingUrls) {
      const fromUrl = usableEmployerDomain(employerDomainFromUrl(url), company.name)
      if (fromUrl) {
        domain = fromUrl
        domainBasis = `the job posting's own URL host (${fromUrl})`
        break
      }
    }
  }
  if (!domain) {
    domainBasis =
      'no employer domain on file — the company record, the dossier and the posting URL all lack one (or point at an aggregator/ATS host)'
  }

  // 4) Existing contacts at this company — for dedupe AND as pattern anchors.
  const { data: existingRows } = await client
    .from('contacts')
    .select('id, name, email, title, source, confidence, verified')
    .eq('user_id', userId)
    .eq('company_id', companyId)
  const existing = (existingRows as ExistingContactRow[] | null) ?? []
  const existingEmails = new Set(existing.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e))
  const existingNames = new Set(existing.map((c) => c.name?.toLowerCase()).filter((n): n is string => !!n))

  // --- FREE PATH ---

  // 4a) Posting text.
  const postingCandidates: ContactCandidate[] = []
  let postingChars = 0
  for (const p of postingTexts) {
    postingChars += p.text.length
    postingCandidates.push(...extractPostingCandidates(p.text, domain))
  }
  steps.push({
    key: 'posting',
    label: postingTexts.length > 1 ? `${fmt(postingTexts.length)} job postings` : 'the job posting',
    status: postingTexts.length === 0 ? 'skipped' : postingCandidates.length > 0 ? 'found' : 'empty',
    scanned: postingTexts.length === 0 ? null : `${fmt(postingChars)} characters`,
    found: postingCandidates.length,
    detail:
      postingTexts.length === 0
        ? jobId
          ? 'no posting body stored on this job — some job feeds only give a title and a link'
          : 'no posting body stored for any job at this company yet'
        : postingCandidates.length > 0
          ? 'named people or published addresses found in the posting body'
          : 'the posting body names no one and publishes no email address',
  })

  // 4b) The company's OWN public pages — the highest-yield free source, and
  //     the one that was missing entirely. Guarded by lib/dossier/sources.ts
  //     (host-allowlisted to this domain, https-only, same-site redirects only).
  const siteCandidates: ContactCandidate[] = []
  const wantSite = params.fetchSite !== false
  let sitePages: { url: string; text: string }[] = []
  if (!wantSite) {
    steps.push({ key: 'site', label: "the company's own website", status: 'skipped', scanned: null, found: 0, detail: 'site fetching was disabled for this run' })
  } else if (!domain) {
    steps.push({
      key: 'site',
      label: "the company's own website",
      status: 'skipped',
      scanned: null,
      found: 0,
      detail: `${domainBasis}; add a domain on the company page and this becomes searchable`,
    })
  } else {
    try {
      // 1) Read back stored research first (fresh <14 days home/about/careers
      // text from a prior company_researcher run — see lib/kb/ingest.ts) and
      // only live-fetch when it's absent or stale. Skips the network entirely
      // on the common case: a dossier already exists for this company.
      const cached = await readFreshCompanyPages(client, userId, companyId, domain)
      sitePages = cached ?? (await fetchCompanyContactPages(domain))
      for (const page of sitePages) siteCandidates.push(...extractSiteCandidates(page, domain))
      steps.push({
        key: 'site',
        label: `${domain} (home, /about, /about-us, /team, /careers, /contact)`,
        status: sitePages.length === 0 ? 'error' : siteCandidates.length > 0 ? 'found' : 'empty',
        scanned:
          sitePages.length === 0
            ? null
            : `${fmt(sitePages.length)} page${sitePages.length === 1 ? '' : 's'}, ${fmt(sitePages.reduce((n, p) => n + p.text.length, 0))} characters${cached ? ' (from stored research, no fetch)' : ''}`,
        found: siteCandidates.length,
        detail:
          sitePages.length === 0
            ? 'none of those pages could be read (they may not exist, may be JavaScript-rendered, or may have blocked the request)'
            : siteCandidates.length > 0
              ? 'names or addresses published on the company’s own pages'
              : 'those pages publish no email address and name no one in a role we could attribute',
      })
    } catch {
      steps.push({ key: 'site', label: `${domain}`, status: 'error', scanned: null, found: 0, detail: 'the site fetch failed' })
    }
  }

  // 4c) Dossier text.
  const dossierRaw = (dossier?.signals?.raw ?? {}) as { wikipediaSummary?: unknown; github?: { description?: unknown } | null }
  const dossierCandidates = dossier
    ? extractDossierCandidates({
        summary: dossier.summary,
        culture: dossier.signals?.culture ?? null,
        whatTheyWant: dossier.signals?.whatTheyWant ?? null,
        funding: dossier.signals?.funding ?? null,
        headcountTrend: dossier.signals?.headcountTrend ?? null,
        sourceTitles: [
          ...(dossier.sources ?? []).map((s) => s.title),
          ...(dossier.signals?.news ?? []).map((n) => n.title),
        ],
        rawText: [
          typeof dossierRaw.wikipediaSummary === 'string' ? dossierRaw.wikipediaSummary : '',
          typeof dossierRaw.github?.description === 'string' ? dossierRaw.github.description : '',
        ].filter(Boolean),
      })
    : []
  steps.push({
    key: 'dossier',
    label: 'the stored company research (dossier)',
    status: !dossier ? 'skipped' : dossierCandidates.length > 0 ? 'found' : 'empty',
    scanned: dossier ? `summary + ${fmt((dossier.sources ?? []).length)} cited source${(dossier.sources ?? []).length === 1 ? '' : 's'}` : null,
    found: dossierCandidates.length,
    detail: !dossier
      ? 'no dossier for this company yet — run company research first and this becomes searchable'
      : dossierCandidates.length > 0
        ? 'a person is named in the research text'
        : 'the research text is a company summary and names no individual',
  })

  // 4d) Pattern anchors. Widened beyond "contacts at THIS company row": any
  //     contact of this user whose address lives at the resolved domain proves
  //     the company's address format just as well, and duplicate company rows
  //     are common enough here that the narrow query missed real anchors.
  const knownGood: KnownGoodContact[] = existing
    .filter((c): c is ExistingContactRow & { email: string } => !!c.email && !!c.name)
    .map((c) => ({ name: c.name, email: c.email }))
  let sameDomainAnchors = 0
  if (domain) {
    const { data: anchorRows } = await client
      .from('contacts')
      .select('name, email')
      .eq('user_id', userId)
      .ilike('email', `%${domain}`)
      .limit(PATTERN_ANCHOR_SCAN_LIMIT)
    for (const row of (anchorRows as { name: string | null; email: string | null }[] | null) ?? []) {
      if (!row.name || !row.email) continue
      // `ilike '%domain'` is a cheap prefilter, not a host check — "@notacme.com"
      // matches it too, so the real host comparison happens here.
      if (!hostBelongsToDomain(normalizeDomain(row.email.split('@')[1] ?? null), domain)) continue
      if (knownGood.some((k) => k.email.toLowerCase() === row.email!.toLowerCase())) continue
      knownGood.push({ name: row.name, email: row.email })
      sameDomainAnchors++
    }
  }
  // An address published in the posting or on the site is itself a known-good
  // example of this company's format.
  for (const c of [...postingCandidates, ...siteCandidates]) {
    if (c.email && c.name && !c.emailInferred) knownGood.push({ name: c.name, email: c.email })
  }

  let nameOnly = [...dossierCandidates, ...postingCandidates, ...siteCandidates].filter((c) => c.name && !c.email)

  // --- BYOK: Hunter (domain search, then email-finder for leftover names, then verifier on the top pattern guess) ---
  const providers: ProviderOutcome[] = []
  let hunterCandidates: ContactCandidate[] = []
  if (!hunterKey) {
    providers.push({ provider: 'hunter', ran: false, reason: 'no-key', found: 0 })
    steps.push({ key: 'hunter', label: 'Hunter.io email database', status: 'skipped', scanned: null, found: 0, detail: 'no Hunter.io API key configured — add one in Settings to search a real email database (optional)' })
  } else if (!domain) {
    providers.push({ provider: 'hunter', ran: false, reason: 'no-domain', found: 0 })
    steps.push({ key: 'hunter', label: 'Hunter.io email database', status: 'skipped', scanned: null, found: 0, detail: `${domainBasis}; Hunter needs one` })
  } else {
    let hunterFailed = false
    try {
      hunterCandidates = await hunterDomainSearch({ apiKey: hunterKey, domain, limit: 10, timeoutMs: 8000 })
      providers.push({ provider: 'hunter', ran: true, found: hunterCandidates.length })
    } catch {
      hunterFailed = true
      providers.push({ provider: 'hunter', ran: false, reason: 'error', found: 0 })
    }

    // Resolve a bounded number of remaining name-only mentions via Hunter's
    // own email-finder before falling back to our own pattern guess.
    const resolvedNames = new Set<string>()
    for (const target of nameOnly.slice(0, MAX_HUNTER_FINDER_LOOKUPS)) {
      if (!target.name || signal?.aborted) break
      try {
        const found = await hunterEmailFinder({ apiKey: hunterKey, domain, name: target.name, timeoutMs: 6000 })
        if (found) {
          hunterCandidates.push({
            ...found,
            title: target.title ?? found.title,
            basis: `Name mentioned in ${target.source === 'dossier' ? 'the company dossier' : target.source === 'site' ? 'the company website' : 'the job posting'}; email resolved via Hunter.io's email finder for "${target.name}" at ${domain}.`,
          })
          resolvedNames.add(target.name.toLowerCase())
        }
      } catch {
        // isolated — one finder miss never blocks the rest of the pipeline
      }
    }
    nameOnly = nameOnly.filter((c) => !c.name || !resolvedNames.has(c.name.toLowerCase()))
    steps.push({
      key: 'hunter',
      label: `Hunter.io email database (${domain})`,
      status: hunterFailed ? 'error' : hunterCandidates.length > 0 ? 'found' : 'empty',
      scanned: hunterFailed ? null : 'domain search + up to 3 name lookups',
      found: hunterCandidates.length,
      detail: hunterFailed
        ? 'the Hunter.io request failed (bad key, rate limit, or outage) — the free sources above still ran'
        : hunterCandidates.length > 0
          ? 'addresses returned by Hunter.io'
          : `Hunter.io has no indexed addresses for ${domain}`,
    })
  }

  // --- BYOK: Apollo people search ---
  let apolloCandidates: ContactCandidate[] = []
  if (!apolloKey) {
    providers.push({ provider: 'apollo', ran: false, reason: 'no-key', found: 0 })
    steps.push({ key: 'apollo', label: 'Apollo.io people search', status: 'skipped', scanned: null, found: 0, detail: 'no Apollo.io API key configured — optional' })
  } else if (!domain) {
    providers.push({ provider: 'apollo', ran: false, reason: 'no-domain', found: 0 })
    steps.push({ key: 'apollo', label: 'Apollo.io people search', status: 'skipped', scanned: null, found: 0, detail: `${domainBasis}; Apollo needs one` })
  } else {
    let apolloFailed = false
    try {
      apolloCandidates = await apolloPeopleSearch({ apiKey: apolloKey, domain, companyName: company.name, limit: 10, timeoutMs: 8000 })
      providers.push({ provider: 'apollo', ran: true, found: apolloCandidates.length })
    } catch {
      apolloFailed = true
      providers.push({ provider: 'apollo', ran: false, reason: 'error', found: 0 })
    }
    steps.push({
      key: 'apollo',
      label: `Apollo.io people search (${domain})`,
      status: apolloFailed ? 'error' : apolloCandidates.length > 0 ? 'found' : 'empty',
      scanned: apolloFailed ? null : 'people search by domain',
      found: apolloCandidates.length,
      detail: apolloFailed
        ? 'the Apollo.io request failed (bad key, rate limit, or outage) — the free sources above still ran'
        : apolloCandidates.length > 0
          ? 'people returned by Apollo.io'
          : `Apollo.io has no people indexed for ${domain}`,
    })
  }

  // --- Pattern fallback for whatever names remain unresolved ---
  const patternCandidates = domain ? inferPatternCandidates(nameOnly, knownGood, domain) : []
  steps.push({
    key: 'pattern',
    label: 'email-pattern inference',
    status: !domain || knownGood.length === 0 ? 'skipped' : patternCandidates.length > 0 ? 'found' : 'empty',
    scanned:
      knownGood.length > 0
        ? `${fmt(knownGood.length)} known-good address${knownGood.length === 1 ? '' : 'es'} at ${domain}, ${fmt(nameOnly.length)} name${nameOnly.length === 1 ? '' : 's'} without an address`
        : null,
    found: patternCandidates.length,
    detail: !domain
      ? `${domainBasis}; there is no domain to build an address on`
      : knownGood.length === 0
        ? `no known-good address at ${domain} to learn the format from — import or add one contact there and every name we find becomes reachable`
        : nameOnly.length === 0
          ? 'no name was left without an address to infer one for'
          : patternCandidates.length > 0
            ? 'addresses inferred from a learned pattern (INFERRED, never verified)'
            : 'the known-good addresses matched none of the common corporate formats',
  })

  // A Hunter key lets us CHECK (not just guess) the single best pattern
  // candidate: confirmed-bad gets dropped, confirmed-good gets verified=true.
  if (hunterKey && domain && patternCandidates.length > 0) {
    const top = patternCandidates[0]
    if (top.email) {
      try {
        const verdict = await hunterVerifyEmail({ apiKey: hunterKey, email: top.email, timeoutMs: 6000 })
        if (verdict?.status === 'undeliverable') {
          patternCandidates.splice(0, 1)
        } else if (verdict?.status === 'deliverable') {
          top.verified = true
          top.confidence = Math.max(top.confidence, 0.85)
          top.basis += " Confirmed deliverable by Hunter.io's email verifier."
        }
      } catch {
        // verifier failure — leave the unverified guess exactly as it was
      }
    }
  }

  let candidates = dedupeCandidates([
    ...dossierCandidates,
    ...postingCandidates,
    ...siteCandidates,
    ...patternCandidates,
    ...hunterCandidates,
    ...apolloCandidates,
  ])
  candidates.sort((a, b) => rank(b) - rank(a) || (b.email ? 1 : 0) - (a.email ? 1 : 0))
  candidates = candidates.slice(0, limit)

  // Report the existing-contacts read too — "you already know 4 people here"
  // is a real search result, and silence about it is what made the empty state
  // read as a broken button.
  steps.push({
    key: 'existing',
    label: 'contacts already on file',
    status: existing.length > 0 ? 'found' : 'empty',
    scanned: `${fmt(existing.length)} at this company${domain ? `, ${fmt(sameDomainAnchors)} more at ${domain}` : ''}`,
    found: existing.length,
    detail:
      existing.length > 0
        ? 'used to avoid duplicates and to learn this company’s address format'
        : 'no contacts at this company yet — nothing to dedupe against, and no known-good address to learn the format from',
  })

  // --- Persist: skip anything already known, insert the rest ---
  const inserted: SourceContactsResult['inserted'] = []
  let skippedExisting = 0
  for (const c of candidates) {
    const dup = c.email ? existingEmails.has(c.email.toLowerCase()) : c.name ? existingNames.has(c.name.toLowerCase()) : false
    if (dup) {
      skippedExisting++
      continue
    }
    if (!c.name && !c.email) continue

    // A role inbox has no person behind it, so the row is named with the whole
    // address rather than its local part: "careers" reads like somebody's
    // first name and would end up in the salutation of a drafted email, while
    // "careers@doist.com" cannot be mistaken for a human.
    const displayName = c.name || c.email || 'Unknown contact'
    const insertRow: Record<string, unknown> = {
      user_id: userId,
      company_id: companyId,
      name: displayName,
      email: c.email,
      title: c.title,
      relationship: 'sourced',
      notes: c.basis,
      source: c.source,
      confidence: c.confidence,
      verified: c.verified,
      basis: c.basis,
    }

    const { data: row, error } = await client.from('contacts').insert(insertRow).select('id, name, email').single()
    if (error || !row) continue
    const inserted_row = row as { id: string; name: string; email: string | null }
    inserted.push({ id: inserted_row.id, name: inserted_row.name, email: inserted_row.email, source: c.source })
    if (c.email) existingEmails.add(c.email.toLowerCase())
    if (c.name) existingNames.add(c.name.toLowerCase())
  }

  return {
    companyId,
    companyName: company.name,
    domain,
    jobId: jobId ?? null,
    candidates,
    inserted,
    skippedExisting,
    providers,
    freePathOnly: !hunterKey && !apolloKey,
    provenanceColumnsAvailable: true,
    search: {
      headline: buildHeadline(steps, inserted.length, skippedExisting),
      steps,
      domain,
      domainBasis,
    },
  }
}
