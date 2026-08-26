// Per-provider, per-posting submission capability — the module that decides
// whether an application may be POSTed at all, and says WHY when it may not.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// types.ts used to state the boundary as "a submit is attempted ONLY when an
// explicit employer/API credential is configured". That is a rule about ONE
// input, so the engine could only ever answer "credential? yes/no" — it had no
// way to know whether the posting it was about to submit to could actually
// receive a complete application. This module replaces that single-bit gate
// with an evidence-based assessment, and the evidence below was gathered by
// reading vendor documentation and issuing GET/OPTIONS requests against real
// public endpoints on 2026-08-03. No application was ever POSTed to gather it.
//
// ─────────────────────────────────────────────────────────────────────────────
// FINDING 1 — NO PROVIDER OFFERS A CANDIDATE-SIDE SUBMISSION ENDPOINT.
//
// All three submission APIs are keyed to the EMPLOYER, and the key is minted
// inside the employer's own admin console. A job-seeker cannot obtain one:
//
//   Greenhouse  "This method requires HTTP Basic Auth over SSL/TLS: the Basic
//               Auth username is your API key (found on the API Credentials
//               page). No password is required."
//               — developers.greenhouse.io/job-board.html#submit-an-application
//
//   Lever       "To use the POST API, you need an API key, which a Super Admin
//               of your account can generate from your integrations settings
//               page."  — github.com/lever/postings-api README
//               Verified empirically with a NON-MUTATING OPTIONS request to
//               https://api.lever.co/v0/postings/leverdemo/5ac21346-…, which
//               returned:
//                 {"ok":false,"error":"You need an API key. Please contact
//                  support@lever.co for a key"}
//
//   Ashby       applicationForm.submit requires the `candidatesWrite`
//               permission on an org API key managed by an Ashby Admin at
//               app.ashbyhq.com/admin/api/keys.
//               — developers.ashbyhq.com/docs/authentication
//
// FINDING 2 — EVERY HOSTED APPLICATION FORM IS CHALLENGE-GATED.
//
// The browser route is therefore permanently off-limits (see types.ts hard
// boundary 1 — we neither solve nor route around a challenge):
//
//   Lever       jobs.lever.co/{site}/{id}/apply serves
//               <script src="https://js.hcaptcha.com/1/secure-api.js">, renders
//               an invisible hCaptcha (sitekey e33f87f8-88ec-…) and stuffs the
//               token into a hidden `h-captcha-response` input on submit.
//               (GET, 2026-08-03.)
//   Greenhouse  job-boards.greenhouse.io ships
//               GOOGLE_RECAPTCHA_ENDPOINT=recaptcha/enterprise.js plus a
//               GOOGLE_RECAPTCHA_INVISIBLE_KEY in its board-renderer config.
//   Ashby       jobs.ashbyhq.com/{org}/{id}/application ships
//               `recaptchaPublicSiteKey` and hides the grecaptcha badge.
//
// Greenhouse's own docs also push integrators AWAY from custom forms: "we
// would encourage customers to make use of the Embedded Job Application …
// Our application form is well tested, validated, battle-hardened, and has
// built-in spam protection measures."
//
// FINDING 3 — GREENHOUSE ACCEPTS INCOMPLETE APPLICATIONS SILENTLY.
//
// "Note that when submitting an application through this method, Greenhouse
//  will not confirm the inclusion of required fields. Validation for required
//  fields must be done on the client side, as Greenhouse will not reject
//  applications that are missing required fields."
//
// This is the most dangerous fact in the whole research pass. A credentialed
// POST that omits a required question does not fail loudly — it lands in the
// employer's pipeline as a half-answered application under the user's real
// name. So for Greenhouse, holding a credential is NOT sufficient; we must
// also prove the form is one we can complete.
//
// FINDING 4 — ONLY GREENHOUSE PUBLISHES THE FORM SCHEMA PUBLICLY.
//
//   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true
//
// returns, with no auth at all, every question's field name, type, required
// flag and select options, plus `compliance`, `demographic_questions` and
// `data_compliance`. That makes Finding 3 defensible in code.
//
// Lever's posting API (/v0/postings/{site}/{id}) and Ashby's public board API
// (/posting-api/job-board/{org}) were both fetched and neither returns any
// form/question/custom-field key — verified 2026-08-03. Lever's README says
// so outright: "Please make sure you coordinate with your Lever administrator
// to learn which fields on the job application they've selected as required."
// Ashby's form spec lives behind the authenticated jobPosting.info endpoint.
//
// FINDING 5 — IN PRACTICE, REAL POSTINGS ALWAYS ASK SOMETHING WE MAY NOT ANSWER.
//
// 30 live Greenhouse postings were sampled across five boards (gitlab, discord,
// anthropic, figma, airtable). EVERY ONE had at least one REQUIRED custom
// question. Real examples, verbatim:
//   · "Will you now or in the future require sponsorship for a visa…"  (visa)
//   · "Are you subject to any employment agreements and/or post-employment
//      restrictions with your current employer…"                       (legal)
//   · "How are you using AI today in your current role?"        (free text —
//                                        answering it means inventing content)
//   · "…you will not be considered unless you complete the Constellation
//      application form."                        (an out-of-band redirect)
//
// That is not a failure of this engine, it is the shape of the market: a
// complete, honest application usually needs its human. What this module buys
// is that the human is asked BEFORE anything is sent, not after a deficient
// application already went out.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS MODULE ENFORCES
//
//   A POST happens only when EVERY one of these holds:
//     1. the posting parses to a supported provider with a posting id;
//     2. an explicit human authorization for THIS job reached this layer;
//     3. an employer credential for that provider is configured;
//     4. identity + resume content are complete enough to be honest;
//     5. no knock-out question was detected in the job description;
//     6. and, where the form schema is publicly readable (Greenhouse), the
//        schema proves every required question is one we can answer from
//        identity + resume + cover letter alone.
//   Anything unknown, unreadable or unmapped resolves to HANDOFF.

import type { ApplyProfile, ApplyProviderId, DetectedApply, SubmitAuthorization } from './types'
import { scanKnockouts } from './readiness'
import { assertAllowedHost, fetchJson } from '@/lib/ats'

/**
 * How an application may reach the employer.
 *   official-api     a credentialed POST to the vendor's own API.
 *   browser-assisted a real browser can reach and prefill the hosted form (the
 *                     target is a detected, supported ATS with a posting id)
 *                     but no employer credential exists to POST with — the gap
 *                     Finding 1 says is permanent for almost every real user.
 *                     A human still reviews and clicks submit themselves; see
 *                     docs/superpowers/specs/2026-08-16-langgraph-port-design.md
 *                     ("browser-use assisted apply"). Consumed by that feature,
 *                     not yet acted on here — submitApplication() still treats
 *                     anything other than 'official-api' as a handoff.
 *   handoff          the human finishes this one unassisted.
 */
export type SubmitRoute = 'official-api' | 'browser-assisted' | 'handoff'

export type CapabilityBlockerCode =
  /** URL is not a Greenhouse/Lever/Ashby posting we can parse. */
  | 'unsupported-ats'
  /** Provider recognized but the URL carries no posting id to submit against. */
  | 'missing-posting-id'
  /** No human said yes to this batch — the gate that can never be inferred. */
  | 'missing-human-authorization'
  /** A human said yes, but to a different job than the one being submitted. */
  | 'authorization-job-mismatch'
  /** The confirmation is old enough that it can no longer be assumed current. */
  | 'stale-human-authorization'
  /** No employer credential configured — the only submission route that exists. */
  | 'missing-employer-credential'
  /** Identity/resume too incomplete to send anything honest. */
  | 'identity-incomplete'
  /** The JD raises visa/clearance/salary/EEO — always the human's to answer. */
  | 'knockout-question'
  /** The form schema is readable in principle but we could not read it now. */
  | 'form-schema-unavailable'
  /** A required question exists that we may not or cannot answer. */
  | 'required-question-unanswerable'
  /** The posting demands an affirmative data-processing consent from the person. */
  | 'consent-required'
  /** The provider's JSON API cannot carry the resume, so the send would be gutted. */
  | 'resume-not-attachable'

export interface CapabilityBlocker {
  code: CapabilityBlockerCode
  /** Human-readable, safe to show the user verbatim in the handoff view. */
  detail: string
}

/**
 * Documented, source-cited facts about each provider's submission surface.
 * Deliberately data rather than prose so tests can assert on it and the UI can
 * explain to a user WHY a given board will always need their hands.
 */
export interface ProviderSubmitFacts {
  provider: ApplyProviderId
  /**
   * Is there a documented endpoint a CANDIDATE may POST an application to
   * without holding employer credentials? `false` for all three — see Finding 1.
   * If this is ever `true` for a provider, that provider gained a genuinely new
   * route and the assessment below must be extended, not just this flag.
   */
  candidateDirectSubmit: false
  /** Who the submission credential belongs to. Always the employer today. */
  credentialHolder: 'employer'
  /** The documented submission endpoint, as a template. */
  submitEndpoint: string
  /** How the credential travels. Greenhouse/Ashby: Basic. Lever: `?key=`. */
  submitAuth: 'basic-api-key' | 'query-api-key'
  /** The challenge guarding the hosted form, i.e. why the browser route is out. */
  hostedFormChallenge: 'hcaptcha' | 'recaptcha-enterprise' | 'recaptcha'
  /** Publicly readable form schema, or null when there is none. */
  publicFormSchemaEndpoint: string | null
  /**
   * Does the vendor reject a submission that omits a required field? Greenhouse
   * explicitly does NOT (Finding 3), which is why its route needs the schema.
   */
  serverValidatesRequiredFields: boolean
  /** Documented submission rate limit, when the vendor publishes one. */
  maxSubmitsPerSecond: number | null
  /**
   * Can a JSON submission carry the resume at all? This transport posts JSON
   * (lib/ats-apply/http.ts), and the answer differs sharply by vendor:
   *   greenhouse  yes — `resume_content` + `resume_content_filename` is a
   *               documented JSON upload method.
   *   lever       degraded — "Only in `multipart/form-data` mode. Should be a
   *               file." We carry the text in `comments` instead, which is
   *               honest but is not an attachment.
   *   ashby       no — `_systemfield_resume` needs a handle from
   *               file.createFileUploadHandle, whose presigned-upload host is
   *               unknowable ahead of time and unverifiable without a real org
   *               key. Blocks the submit rather than dropping the resume.
   */
  jsonSubmitResumeSupport: 'attachment' | 'text-only' | 'none'
  sources: readonly string[]
}

export const PROVIDER_SUBMIT_FACTS: Record<ApplyProviderId, ProviderSubmitFacts> = {
  greenhouse: {
    provider: 'greenhouse',
    candidateDirectSubmit: false,
    credentialHolder: 'employer',
    submitEndpoint: 'https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}',
    submitAuth: 'basic-api-key',
    hostedFormChallenge: 'recaptcha-enterprise',
    publicFormSchemaEndpoint:
      'https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true',
    // The single most consequential finding — see Finding 3.
    serverValidatesRequiredFields: false,
    maxSubmitsPerSecond: null,
    jsonSubmitResumeSupport: 'attachment',
    sources: [
      'https://developers.greenhouse.io/job-board.html#submit-an-application',
      'https://github.com/grnhse/greenhouse-api-docs/blob/master/source/includes/job-board/_applications.md',
    ],
  },
  lever: {
    provider: 'lever',
    candidateDirectSubmit: false,
    credentialHolder: 'employer',
    // NOTE the shape: the posting id is the LAST path segment and the key is a
    // query parameter. There is no `/apply` suffix and no Authorization header.
    submitEndpoint: 'https://api.lever.co/v0/postings/{site}/{postingId}?key={apiKey}',
    submitAuth: 'query-api-key',
    hostedFormChallenge: 'hcaptcha',
    publicFormSchemaEndpoint: null,
    serverValidatesRequiredFields: true,
    // "Lever will return a 429 … if your custom job site issues more than 2
    // application POST requests per second."
    maxSubmitsPerSecond: 2,
    jsonSubmitResumeSupport: 'text-only',
    sources: ['https://github.com/lever/postings-api#apply-to-a-job-posting'],
  },
  ashby: {
    provider: 'ashby',
    candidateDirectSubmit: false,
    credentialHolder: 'employer',
    submitEndpoint: 'https://api.ashbyhq.com/applicationForm.submit',
    submitAuth: 'basic-api-key',
    hostedFormChallenge: 'recaptcha',
    // jobPosting.info returns the form spec but is itself API-key gated.
    publicFormSchemaEndpoint: null,
    serverValidatesRequiredFields: true,
    maxSubmitsPerSecond: null,
    jsonSubmitResumeSupport: 'none',
    sources: [
      'https://developers.ashbyhq.com/docs/creating-a-custom-careers-page',
      'https://developers.ashbyhq.com/reference/applicationformsubmit',
      'https://developers.ashbyhq.com/docs/authentication',
    ],
  },
}

/**
 * A human confirmation older than this is not treated as current. A run can be
 * queued behind a backlog, so this is generous rather than tight — but it does
 * mean an approval from last month cannot be replayed into a fresh submission.
 */
export const AUTHORIZATION_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Greenhouse question field names we can fill from identity + resume + cover
 * letter WITHOUT inventing anything. Everything outside this set is either a
 * custom question (an employer-authored prompt) or a compliance field, and both
 * belong to the human. Names are taken verbatim from the documented form.
 */
const GREENHOUSE_AUTO_ANSWERABLE_FIELDS: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'email',
  'phone',
  'resume',
  'resume_text',
  'cover_letter',
  'cover_letter_text',
])

/**
 * Field names that carry demographic/EEO/legal answers. These must never be
 * emitted by any adapter, so they are named here as well as in fields.ts —
 * capability is where a submit is authorized, so it is also where the list that
 * must never be sent belongs.
 */
export const NEVER_SUBMITTED_FIELDS: readonly string[] = [
  'gender',
  'race',
  'veteran_status',
  'disability_status',
  'demographic_answers',
]

/** What a publicly readable application form told us about a specific posting. */
export interface PostingFormFacts {
  provider: ApplyProviderId
  /** Where these facts came from — recorded so a decision stays auditable. */
  source: string
  /** Required questions we can answer from identity + resume + cover letter. */
  requiredAnswerable: string[]
  /** Required questions we may not or cannot answer. Any entry blocks a POST. */
  requiredUnanswerable: {
    field: string
    label: string
    /** 'sensitive' = legal/demographic/visa/salary; 'unmapped' = we'd invent it. */
    reason: 'sensitive' | 'unmapped'
  }[]
  /** The posting demands an affirmative data-processing/retention consent. */
  consentRequired: boolean
  /** An optional EEO/demographic survey is attached (never auto-answered). */
  demographicSurveyPresent: boolean
}

/** Shape of the public `?questions=true` payload, narrowed to what we read. */
interface GreenhouseQuestionPayload {
  questions?: {
    label?: string | null
    required?: boolean | null
    fields?: { name?: string | null; type?: string | null }[] | null
  }[] | null
  compliance?: unknown
  demographic_questions?: unknown
  data_compliance?: {
    requires_consent?: boolean | null
    requires_processing_consent?: boolean | null
    requires_retention_consent?: boolean | null
  }[] | null
}

/** Strip the HTML Greenhouse embeds in question labels, for readable blockers. */
function plainLabel(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse Greenhouse's public `?questions=true` payload into the facts the gate
 * needs. Pure and total: a payload we cannot make sense of yields `null`, which
 * the caller must treat as "unknown" — i.e. handoff — never as "fine".
 */
export function readGreenhouseFormFacts(payload: unknown): PostingFormFacts | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as GreenhouseQuestionPayload
  if (!Array.isArray(p.questions)) return null

  const facts: PostingFormFacts = {
    provider: 'greenhouse',
    source: PROVIDER_SUBMIT_FACTS.greenhouse.publicFormSchemaEndpoint ?? '',
    requiredAnswerable: [],
    requiredUnanswerable: [],
    // Greenhouse returns one entry per configured privacy policy; ANY of the
    // three consent flags means a person has to affirmatively agree.
    consentRequired: (p.data_compliance ?? []).some(
      (c) =>
        c?.requires_consent === true ||
        c?.requires_processing_consent === true ||
        c?.requires_retention_consent === true
    ),
    // Per Greenhouse's docs demographic questions "are always optional", so
    // their presence is recorded but never blocks — we simply never answer them.
    demographicSurveyPresent:
      Array.isArray(p.demographic_questions) ? p.demographic_questions.length > 0 : !!p.demographic_questions,
  }

  for (const q of p.questions) {
    if (!q?.required) continue
    const label = plainLabel(q.label)
    for (const f of q.fields ?? []) {
      const name = f?.name
      if (!name) continue
      if (GREENHOUSE_AUTO_ANSWERABLE_FIELDS.has(name)) {
        facts.requiredAnswerable.push(name)
        continue
      }
      // A required question outside the standard set is the employer's own
      // prompt. If its text trips a knock-out pattern it is doubly off-limits;
      // otherwise answering it at all would mean fabricating content.
      const sensitive = scanKnockouts(label).length > 0
      facts.requiredUnanswerable.push({
        field: name,
        label,
        reason: sensitive ? 'sensitive' : 'unmapped',
      })
    }
  }
  return facts
}

const GREENHOUSE_API_HOSTS = new Set(['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'])

/**
 * Fetch and parse the public Greenhouse form schema for a posting. No auth, GET
 * only, same SSRF posture as every other outbound read (host allowlist, no
 * redirects, bounded timeout — see lib/ats/http.ts).
 *
 * Returns `null` on ANY failure — 404 (post not live on that board), transport
 * error, or a payload we cannot parse. `null` means "unknown", and the gate
 * turns unknown into a handoff rather than a hopeful POST.
 */
export async function fetchGreenhouseFormFacts(
  target: DetectedApply,
  signal?: AbortSignal
): Promise<PostingFormFacts | null> {
  if (!target.jobId) return null
  const host = target.host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io'
  const url = `https://${host}/v1/boards/${target.slug}/jobs/${target.jobId}?questions=true`
  try {
    assertAllowedHost(url, GREENHOUSE_API_HOSTS)
    const payload = await fetchJson<unknown>(url, { signal })
    const facts = readGreenhouseFormFacts(payload)
    return facts ? { ...facts, source: url } : null
  } catch (err) {
    // Logged, never thrown: an unreadable schema is a routing decision (handoff),
    // not an error the caller should have to catch.
    console.warn('ats-apply/capability: greenhouse form schema unreadable, forcing handoff', err)
    return null
  }
}

export interface CapabilityInput {
  target: DetectedApply | null
  /** True when an employer credential for this provider is configured. */
  hasCredential: boolean
  /** The human confirmation, exactly as it reached this layer. */
  authorization?: SubmitAuthorization | null
  /** The `jobs.id` this application targets, matched against the authorization. */
  jobId?: string | null
  profile: ApplyProfile
  /** True when SOME resume text will be attached (adapters share one fallback chain). */
  hasResumeContent: boolean
  jobDescription?: string | null
  /** Publicly read form schema, when the provider publishes one. */
  formFacts?: PostingFormFacts | null
  /** Clock injection point, so tests need not sleep. Defaults to now. */
  now?: number
}

export interface CapabilityAssessment {
  route: SubmitRoute
  provider: ApplyProviderId | null
  /**
   * Empty exactly when `route === 'official-api'`. When `route ===
   * 'browser-assisted'` this holds exactly one entry, `missing-employer-
   * credential` — every other blocker still forces `'handoff'`.
   */
  blockers: CapabilityBlocker[]
  /** True-but-not-disqualifying facts, recorded on the attempt for the user. */
  warnings: string[]
  /** The provider facts this decision was made against, for the audit record. */
  facts: ProviderSubmitFacts | null
}

/**
 * Decide, for ONE posting, whether an official-API submit may be attempted.
 *
 * Conservative by construction: the function starts from "handoff" and only an
 * unbroken chain of positive evidence produces 'official-api'. Every branch
 * that cannot prove something adds a blocker rather than shrugging.
 */
export function assessSubmitCapability(input: CapabilityInput): CapabilityAssessment {
  const blockers: CapabilityBlocker[] = []
  const warnings: string[] = []
  const target = input.target
  const provider = target?.provider ?? null
  const facts = provider ? PROVIDER_SUBMIT_FACTS[provider] : null

  if (!target || !provider || !facts) {
    return {
      route: 'handoff',
      provider: null,
      blockers: [
        {
          code: 'unsupported-ats',
          detail:
            'Posting is not a recognized official ATS (Greenhouse/Lever/Ashby); apply manually.',
        },
      ],
      warnings,
      facts: null,
    }
  }

  if (!target.jobId) {
    blockers.push({
      code: 'missing-posting-id',
      detail: `The ${provider} URL has no posting id, so there is nothing to submit against.`,
    })
  }

  // 1) The human gate. Checked first and independently of everything else: no
  //    amount of readiness anywhere else may stand in for a person saying yes.
  const auth = input.authorization
  if (!auth || auth.confirmed !== true) {
    blockers.push({
      code: 'missing-human-authorization',
      detail:
        'No explicit human confirmation reached the submission engine for this application. ' +
        'Submitting is always your click.',
    })
  } else {
    const confirmedAt = Date.parse(auth.at)
    const now = input.now ?? Date.now()
    if (!Number.isFinite(confirmedAt) || now - confirmedAt > AUTHORIZATION_MAX_AGE_MS) {
      blockers.push({
        code: 'stale-human-authorization',
        detail:
          'The approval backing this submission is missing a usable timestamp or is more than ' +
          '24 hours old; confirm again so the decision is current.',
      })
    }
    // An approval names the jobs it covered. Anything outside that list was
    // never approved, whatever else the run believes.
    if (auth.jobIds && auth.jobIds.length > 0) {
      if (!input.jobId || !auth.jobIds.includes(input.jobId)) {
        blockers.push({
          code: 'authorization-job-mismatch',
          detail: `The approval covers other jobs, not ${input.jobId ?? 'this one'}.`,
        })
      }
    }
  }

  // 2) The credential. Still required — Finding 1 says it is the only route
  //    that exists — but it is now ONE condition among several rather than the
  //    whole gate.
  if (!input.hasCredential) {
    blockers.push({
      code: 'missing-employer-credential',
      detail:
        // Leading phrase deliberately preserved from the previous readiness
        // message: it is the wording the rest of the product (and its tests)
        // already recognizes for this exact condition.
        'No official ATS apply credential configured — routing to review/handoff. ' +
        `${provider}'s application API is keyed to the employer, not the candidate ` +
        `(${facts.sources[0]}), so this is the normal case rather than a misconfiguration.`,
    })
  }

  // 3) Identity + content honesty.
  if (!input.profile.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.profile.email)) {
    blockers.push({ code: 'identity-incomplete', detail: 'Missing or invalid email on profile.' })
  }
  if (!input.profile.firstName) {
    blockers.push({ code: 'identity-incomplete', detail: 'Missing name on profile.' })
  }
  if (!input.hasResumeContent) {
    blockers.push({ code: 'identity-incomplete', detail: 'No resume content available to attach.' })
  } else if (facts.jsonSubmitResumeSupport === 'none') {
    // An application with the resume quietly stripped out is worse than no
    // application: it looks sent, and it reads to the employer as careless.
    blockers.push({
      code: 'resume-not-attachable',
      detail:
        `${provider}'s API can only take a resume as an uploaded file handle, which Cello cannot ` +
        'produce without an unverified upload flow. Rather than send your application without your ' +
        'resume, this one finishes on the board.',
    })
  } else if (facts.jsonSubmitResumeSupport === 'text-only') {
    warnings.push(
      `${provider} accepts resume FILES only in multipart mode, so your resume travels as text in the ` +
        'application comments rather than as an attachment.'
    )
  }

  // 4) Knock-outs in the job description.
  const knockouts = scanKnockouts(input.jobDescription)
  if (knockouts.length > 0) {
    blockers.push({
      code: 'knockout-question',
      detail:
        `Posting includes knock-out question(s) [${knockouts.join(', ')}] that must be ` +
        'answered by you, not auto-filled.',
    })
  }

  // 5) The form itself. Only meaningful where a schema is publicly readable.
  if (facts.publicFormSchemaEndpoint) {
    const form = input.formFacts
    if (!form) {
      blockers.push({
        code: 'form-schema-unavailable',
        detail:
          `Could not read ${provider}'s public application form for this posting, and ` +
          `${provider} accepts applications that are missing required answers without ` +
          'complaining — so sending one blind could put a half-finished application in your name.',
      })
    } else {
      if (form.consentRequired) {
        blockers.push({
          code: 'consent-required',
          detail:
            'This posting requires you to personally consent to how your data is processed and ' +
            'retained. Consent is yours to give, so this one finishes in your hands.',
        })
      }
      for (const q of form.requiredUnanswerable) {
        blockers.push({
          code: 'required-question-unanswerable',
          detail:
            q.reason === 'sensitive'
              ? `Required question "${q.label || q.field}" is legal/demographic/eligibility — never auto-answered.`
              : `Required question "${q.label || q.field}" has no honest answer we can derive from your profile.`,
        })
      }
      if (form.demographicSurveyPresent) {
        warnings.push(
          'Posting attaches an optional EEO/demographic survey. It is left blank — those answers are yours alone.'
        )
      }
    }
  } else {
    // Lever and Ashby publish no candidate-readable form schema (Finding 4), so
    // completeness cannot be verified from this side at all. We do not turn that
    // into a permanent block: the credential holder is the employer admin who
    // authored the form and does know its required fields, and both vendors DO
    // reject incomplete submissions server-side (unlike Greenhouse). It is
    // recorded on the attempt so the user can see what was and was not checked.
    warnings.push(
      `${provider} does not publish its application form publicly, so required-question ` +
        `completeness could not be verified before sending. ${provider} rejects incomplete ` +
        'submissions server-side, so a failure here surfaces as an error rather than a silent gap.'
    )
  }

  if (facts.maxSubmitsPerSecond != null) {
    warnings.push(
      `${provider} rate-limits applications to ${facts.maxSubmitsPerSecond}/second and answers 429 above that.`
    )
  }

  // A missing employer credential (Finding 1) is the one blocker a real
  // browser session can bridge: the target is a detected, supported ATS
  // (reaching this line already proved that), so a human can still be shown
  // the actual hosted form, prefilled, to review and submit themselves. Any
  // OTHER blocker — a missing/stale/mismatched authorization, an incomplete
  // identity, a knock-out, an unreadable or unanswerable form — is not fixed
  // by putting a browser in front of the page, so it still forces a plain
  // handoff.
  const onlyMissingCredential =
    blockers.length === 1 && blockers[0].code === 'missing-employer-credential'

  return {
    route: blockers.length === 0 ? 'official-api' : onlyMissingCredential ? 'browser-assisted' : 'handoff',
    provider,
    blockers,
    warnings,
    facts,
  }
}

/** One-line reason string for the handoff view, built from the blockers. */
export function describeBlockers(blockers: CapabilityBlocker[]): string {
  return blockers.map((b) => b.detail).join(' ')
}
