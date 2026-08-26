// Tests for lib/ats-apply/capability.ts — the gate that decides whether an
// application may be POSTed at all.
//
// ZERO NETWORK. Every Greenhouse payload below is a REAL `?questions=true`
// response captured by GET from boards-api.greenhouse.io on 2026-08-03, trimmed
// to the keys the parser reads. They are fixtures precisely because the shapes
// employers actually configure (a required free-text prompt, a required visa
// question, an optional EEO survey) are the ones the gate has to get right, and
// inventing those shapes would prove nothing.
//
// The properties under test are the ones that keep a real person's name safe:
//   1. Without a human's confirmation, nothing submits. Ever.
//   2. A confirmation for other jobs, or a stale one, does not authorize this one.
//   3. An employer credential alone is not enough.
//   4. A required question we cannot honestly answer blocks the submit —
//      because Greenhouse would otherwise ACCEPT the incomplete application.
//   5. An unreadable form is treated as unknown, therefore handoff.
//   6. Consent and demographic answers are never given on the user's behalf.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { submitApplication, buildDraftAnswers } from './index'
import {
  assessSubmitCapability,
  readGreenhouseFormFacts,
  fetchGreenhouseFormFacts,
  describeBlockers,
  PROVIDER_SUBMIT_FACTS,
  NEVER_SUBMITTED_FIELDS,
  AUTHORIZATION_MAX_AGE_MS,
  type CapabilityBlockerCode,
  type PostingFormFacts,
} from './capability'
import { isSubmitAuthorization } from './types'
import type { ApplyProfile, DetectedApply, SubmitAuthorization } from './types'

// --- real captured fixtures -------------------------------------------------

/**
 * airtable/8654173002, 2026-08-03. The friendliest real form found in a 30-post
 * sample: standard fields plus ONE required custom question — a free-text
 * prompt about the applicant's own AI work. There is no honest way to derive
 * that answer from a profile, so it must block.
 */
const AIRTABLE_REAL = {
  questions: [
    { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
    { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
    { label: 'Preferred First Name', required: false, fields: [{ name: 'preferred_name', type: 'input_text' }] },
    { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
    { label: 'Phone', required: false, fields: [{ name: 'phone', type: 'input_text' }] },
    {
      label: 'Resume/CV',
      required: true,
      fields: [
        { name: 'resume', type: 'input_file' },
        { name: 'resume_text', type: 'textarea' },
      ],
    },
    {
      label: 'Cover Letter',
      required: false,
      fields: [
        { name: 'cover_letter', type: 'input_file' },
        { name: 'cover_letter_text', type: 'textarea' },
      ],
    },
    { label: 'LinkedIn Profile', required: false, fields: [{ name: 'question_37494965002', type: 'input_text' }] },
    {
      label:
        'How are you using AI today in your current role? If applicable, show us your last AI experiment.',
      required: true,
      fields: [{ name: 'question_37494966002', type: 'textarea' }],
    },
    {
      label: 'Optional: Upload your AI example.',
      required: false,
      fields: [{ name: 'question_37494967002', type: 'input_file' }],
    },
  ],
  data_compliance: [{ type: 'gdpr', requires_consent: false, requires_processing_consent: false, requires_retention_consent: false }],
  demographic_questions: null,
}

/**
 * gitlab/8503792002, 2026-08-03. Required questions include a visa-sponsorship
 * question and a post-employment-restrictions question — both squarely in the
 * category Cello must never answer. Note the HTML-free labels: Greenhouse
 * embeds markup, and the parser has to strip it before a blocker is shown.
 */
const GITLAB_REAL = {
  questions: [
    { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
    { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
    { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
    { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file' }] },
    { label: '<p>LinkedIn Profile</p>', required: false, fields: [{ name: 'question_36101205002', type: 'input_text' }] },
    {
      label:
        'Are you subject to any employment agreements and/or post-employment restrictions with your current employer or any prior employer?',
      required: true,
      fields: [{ name: 'question_36101207002', type: 'multi_value_single_select' }],
    },
    {
      label: 'Will you now or in the future require sponsorship for a visa to remain in your current location?',
      required: true,
      fields: [{ name: 'question_36101209002', type: 'multi_value_single_select' }],
    },
    {
      label: 'What is your current country of residence?',
      required: true,
      fields: [{ name: 'question_36101211002', type: 'multi_value_single_select' }],
    },
  ],
  data_compliance: [{ type: 'gdpr', requires_consent: false }],
  demographic_questions: null,
}

/**
 * A Greenhouse form with ONLY the standard fields required. Not observed in the
 * 30-post sample — every real posting asked something extra — but it is the
 * shape the submit path exists for, so it is exercised deliberately. Derived
 * from the discord/8433948002 payload with its four required custom questions
 * removed, which is why the standard entries below match that response exactly.
 */
const STANDARD_ONLY = {
  questions: [
    { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
    { label: 'Last Name', required: true, fields: [{ name: 'last_name', type: 'input_text' }] },
    { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
    { label: 'Phone', required: false, fields: [{ name: 'phone', type: 'input_text' }] },
    {
      label: 'Resume/CV',
      required: true,
      fields: [
        { name: 'resume', type: 'input_file' },
        { name: 'resume_text', type: 'textarea' },
      ],
    },
  ],
  data_compliance: [{ type: 'gdpr', requires_consent: false }],
  demographic_questions: null,
}

/**
 * The EU/GDPR shape: Greenhouse flags that the applicant must personally
 * consent to processing and retention. Consent given on someone's behalf is
 * not consent, so this always blocks.
 */
const CONSENT_REQUIRED = {
  questions: STANDARD_ONLY.questions,
  data_compliance: [
    { type: 'gdpr', requires_consent: true, requires_processing_consent: true, requires_retention_consent: true },
  ],
  demographic_questions: null,
}

/** Same standard-only form, but with an optional EEO survey attached. */
const WITH_DEMOGRAPHIC_SURVEY = {
  questions: STANDARD_ONLY.questions,
  data_compliance: [{ type: 'gdpr', requires_consent: false }],
  demographic_questions: [{ id: 87, label: 'Gender', required: false }],
}

// --- helpers ----------------------------------------------------------------

const GREENHOUSE_TARGET: DetectedApply = {
  provider: 'greenhouse',
  slug: 'acme',
  jobId: '1234567',
  host: 'boards.greenhouse.io',
}
const LEVER_TARGET: DetectedApply = {
  provider: 'lever',
  slug: 'acme',
  jobId: '5ac21346-8e0c-4494-8e7a-3eb92ff77902',
  host: 'jobs.lever.co',
}
const ASHBY_TARGET: DetectedApply = {
  provider: 'ashby',
  slug: 'acme',
  jobId: '7458d4e9-da2e-47bd-98cb-adfda43d42b2',
  host: 'jobs.ashbyhq.com',
}

const PROFILE: ApplyProfile = {
  firstName: 'Ann',
  lastName: 'Lee',
  fullName: 'Ann Lee',
  email: 'ann@example.com',
}

function freshAuth(over: Partial<SubmitAuthorization> = {}): SubmitAuthorization {
  return { confirmed: true, source: 'submit-confirmed-chain', at: new Date().toISOString(), ...over }
}

/** Everything green: the only configuration that is allowed to reach a POST. */
function readyInput(over: Record<string, unknown> = {}) {
  return {
    target: GREENHOUSE_TARGET,
    hasCredential: true,
    authorization: freshAuth(),
    profile: PROFILE,
    hasResumeContent: true,
    formFacts: readGreenhouseFormFacts(STANDARD_ONLY),
    ...over,
  }
}

function codes(blockers: { code: CapabilityBlockerCode }[]): CapabilityBlockerCode[] {
  return blockers.map((b) => b.code)
}

// --- the research, encoded --------------------------------------------------

describe('PROVIDER_SUBMIT_FACTS records the researched truth per provider', () => {
  it('no provider offers a candidate-side submission route', () => {
    for (const p of ['greenhouse', 'lever', 'ashby'] as const) {
      // If this ever needs changing, a provider genuinely opened a candidate
      // route and assessSubmitCapability must be extended to use it — the flag
      // alone is not a switch that unlocks anything.
      expect(PROVIDER_SUBMIT_FACTS[p].candidateDirectSubmit).toBe(false)
      expect(PROVIDER_SUBMIT_FACTS[p].credentialHolder).toBe('employer')
      expect(PROVIDER_SUBMIT_FACTS[p].sources.length).toBeGreaterThan(0)
    }
  })

  it('every hosted application form is recorded as challenge-gated', () => {
    expect(PROVIDER_SUBMIT_FACTS.lever.hostedFormChallenge).toBe('hcaptcha')
    expect(PROVIDER_SUBMIT_FACTS.greenhouse.hostedFormChallenge).toBe('recaptcha-enterprise')
    expect(PROVIDER_SUBMIT_FACTS.ashby.hostedFormChallenge).toBe('recaptcha')
  })

  it('only Greenhouse publishes a form schema, and only Greenhouse skips server-side required-field validation', () => {
    expect(PROVIDER_SUBMIT_FACTS.greenhouse.publicFormSchemaEndpoint).toContain('questions=true')
    expect(PROVIDER_SUBMIT_FACTS.lever.publicFormSchemaEndpoint).toBeNull()
    expect(PROVIDER_SUBMIT_FACTS.ashby.publicFormSchemaEndpoint).toBeNull()
    // The pairing is the whole reason the schema read exists: Greenhouse will
    // accept an incomplete application without complaining.
    expect(PROVIDER_SUBMIT_FACTS.greenhouse.serverValidatesRequiredFields).toBe(false)
  })

  it("Lever's documented endpoint carries the key as a query parameter, not a Basic header", () => {
    expect(PROVIDER_SUBMIT_FACTS.lever.submitAuth).toBe('query-api-key')
    expect(PROVIDER_SUBMIT_FACTS.lever.submitEndpoint).toContain('?key=')
    expect(PROVIDER_SUBMIT_FACTS.lever.submitEndpoint).not.toContain('/apply')
    expect(PROVIDER_SUBMIT_FACTS.lever.maxSubmitsPerSecond).toBe(2)
  })
})

describe('readGreenhouseFormFacts — parsing REAL captured board payloads', () => {
  it('a real airtable posting: the one required custom question is unanswerable, so it is recorded', () => {
    const facts = readGreenhouseFormFacts(AIRTABLE_REAL)!
    expect(facts).not.toBeNull()
    expect(facts.requiredAnswerable).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'email', 'resume', 'resume_text'])
    )
    expect(facts.requiredUnanswerable).toHaveLength(1)
    expect(facts.requiredUnanswerable[0]).toMatchObject({
      field: 'question_37494966002',
      reason: 'unmapped',
    })
    expect(facts.requiredUnanswerable[0].label).toMatch(/How are you using AI today/)
    // Optional fields never appear as blockers — LinkedIn and the optional
    // upload are both not required on this posting.
    expect(facts.requiredUnanswerable.map((q) => q.field)).not.toContain('question_37494965002')
    expect(facts.requiredUnanswerable.map((q) => q.field)).not.toContain('question_37494967002')
  })

  it('a real gitlab posting: visa and post-employment questions are classified SENSITIVE, not merely unmapped', () => {
    const facts = readGreenhouseFormFacts(GITLAB_REAL)!
    const visa = facts.requiredUnanswerable.find((q) => q.field === 'question_36101209002')!
    expect(visa.reason).toBe('sensitive')
    expect(visa.label).toMatch(/sponsorship for a visa/)
    // Markup that Greenhouse embeds in labels is stripped before display.
    expect(JSON.stringify(facts)).not.toContain('<p>')
  })

  it('a form with only standard required fields yields no blockers to report', () => {
    const facts = readGreenhouseFormFacts(STANDARD_ONLY)!
    expect(facts.requiredUnanswerable).toEqual([])
    expect(facts.consentRequired).toBe(false)
  })

  it('any GDPR consent flag marks the posting as consent-required', () => {
    expect(readGreenhouseFormFacts(CONSENT_REQUIRED)!.consentRequired).toBe(true)
    // Each flag independently suffices — an employer may configure only one.
    expect(
      readGreenhouseFormFacts({ ...STANDARD_ONLY, data_compliance: [{ requires_retention_consent: true }] })!
        .consentRequired
    ).toBe(true)
  })

  it('an unparseable payload yields null — which the gate must read as UNKNOWN, never as fine', () => {
    expect(readGreenhouseFormFacts(null)).toBeNull()
    expect(readGreenhouseFormFacts({})).toBeNull()
    expect(readGreenhouseFormFacts({ id: 999 })).toBeNull() // e.g. a submit response, not a schema
    expect(readGreenhouseFormFacts('<html>')).toBeNull()
  })
})

describe('assessSubmitCapability — the human authorization is not optional', () => {
  it('a fully credentialed, fully ready application still refuses without a human confirmation', () => {
    const a = assessSubmitCapability(readyInput({ authorization: null }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('missing-human-authorization')
    expect(describeBlockers(a.blockers)).toMatch(/Submitting is always your click/)
  })

  it('a confirmation naming OTHER jobs does not authorize this one', () => {
    const a = assessSubmitCapability(
      readyInput({ authorization: freshAuth({ jobIds: ['job-a', 'job-b'] }), jobId: 'job-c' })
    )
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('authorization-job-mismatch')
  })

  it('a confirmation naming THIS job does authorize it', () => {
    const a = assessSubmitCapability(
      readyInput({ authorization: freshAuth({ jobIds: ['job-a', 'job-c'] }), jobId: 'job-c' })
    )
    expect(a.route).toBe('official-api')
    expect(a.blockers).toEqual([])
  })

  it('a confirmation older than the max age is refused as stale, so an old approval cannot be replayed', () => {
    const old = new Date(Date.now() - AUTHORIZATION_MAX_AGE_MS - 60_000).toISOString()
    const a = assessSubmitCapability(readyInput({ authorization: freshAuth({ at: old }) }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('stale-human-authorization')
  })

  it('a confirmation with an unparseable timestamp is refused rather than trusted', () => {
    const a = assessSubmitCapability(readyInput({ authorization: freshAuth({ at: 'whenever' }) }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('stale-human-authorization')
  })
})

describe('isSubmitAuthorization — confirmation must be literal, never coerced', () => {
  it('rejects every truthy stand-in for confirmed:true', () => {
    for (const confirmed of ['true', 1, 'yes', {}, [], 'confirmed']) {
      expect(isSubmitAuthorization({ confirmed, source: 'submit-confirmed-chain', at: new Date().toISOString() })).toBe(
        false
      )
    }
  })

  it('rejects a missing/invalid timestamp, an unknown source, and a malformed jobIds', () => {
    const base = { confirmed: true as const, source: 'submit-confirmed-chain', at: new Date().toISOString() }
    expect(isSubmitAuthorization({ ...base, at: 'not-a-date' })).toBe(false)
    expect(isSubmitAuthorization({ ...base, source: 'autopilot' })).toBe(false)
    expect(isSubmitAuthorization({ ...base, jobIds: [1, 2] })).toBe(false)
    expect(isSubmitAuthorization(null)).toBe(false)
    expect(isSubmitAuthorization(undefined)).toBe(false)
  })

  it('accepts the real shape, with and without the optional fields', () => {
    const at = new Date().toISOString()
    expect(isSubmitAuthorization({ confirmed: true, source: 'human-approval-route', at })).toBe(true)
    expect(
      isSubmitAuthorization({ confirmed: true, source: 'submit-confirmed-chain', at, jobIds: ['j1'], batchId: 'run-9' })
    ).toBe(true)
  })
})

describe('assessSubmitCapability — the employer credential is necessary but no longer sufficient', () => {
  it('without a credential, and everything else green, the route downgrades to browser-assisted rather than a raw handoff', () => {
    const a = assessSubmitCapability(readyInput({ hasCredential: false }))
    expect(a.route).toBe('browser-assisted')
    expect(codes(a.blockers)).toContain('missing-employer-credential')
    expect(describeBlockers(a.blockers)).toMatch(/keyed to the employer, not the candidate/)
  })

  it('WITH a credential and a human confirmation, a real required question still blocks the submit', () => {
    // This is the case the old credential-only gate got wrong: it would have
    // POSTed, and Greenhouse would have accepted the incomplete application.
    const a = assessSubmitCapability(readyInput({ formFacts: readGreenhouseFormFacts(AIRTABLE_REAL) }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('required-question-unanswerable')
    expect(describeBlockers(a.blockers)).toMatch(/no honest answer we can derive/)
  })

  it('a required visa question blocks and is described as never-auto-answered', () => {
    const a = assessSubmitCapability(readyInput({ formFacts: readGreenhouseFormFacts(GITLAB_REAL) }))
    expect(a.route).toBe('handoff')
    expect(describeBlockers(a.blockers)).toMatch(/never auto-answered/)
  })
})

describe('assessSubmitCapability — browser-assisted is the ATS-detected middle route', () => {
  it('a second blocker alongside the missing credential still forces a full handoff', () => {
    const a = assessSubmitCapability(readyInput({ hasCredential: false, authorization: null }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toEqual(
      expect.arrayContaining(['missing-employer-credential', 'missing-human-authorization'])
    )
  })

  it('an unrecognized ATS never becomes browser-assisted, even without a credential — there is no form to prefill', () => {
    const a = assessSubmitCapability({
      target: null,
      hasCredential: false,
      authorization: freshAuth(),
      profile: PROFILE,
      hasResumeContent: true,
    })
    expect(a.route).toBe('handoff')
  })

  it('the same downgrade applies to Lever, which has no public form schema to fail on', () => {
    const a = assessSubmitCapability(
      readyInput({ target: LEVER_TARGET, hasCredential: false, formFacts: null })
    )
    expect(a.route).toBe('browser-assisted')
  })

  it('Ashby never reaches browser-assisted — it cannot carry a resume over JSON, so a second blocker always accompanies the missing credential', () => {
    const a = assessSubmitCapability(
      readyInput({ target: ASHBY_TARGET, hasCredential: false, formFacts: null })
    )
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toEqual(
      expect.arrayContaining(['missing-employer-credential', 'resume-not-attachable'])
    )
  })
})

describe('assessSubmitCapability — unknown always means handoff', () => {
  it('an unreadable Greenhouse form blocks, because a blind POST would be silently accepted', () => {
    const a = assessSubmitCapability(readyInput({ formFacts: null }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('form-schema-unavailable')
    expect(describeBlockers(a.blockers)).toMatch(/half-finished application in your name/)
  })

  it('an unrecognized ATS blocks with no provider and no facts', () => {
    const a = assessSubmitCapability({
      target: null,
      hasCredential: true,
      authorization: freshAuth(),
      profile: PROFILE,
      hasResumeContent: true,
    })
    expect(a.route).toBe('handoff')
    expect(a.provider).toBeNull()
    expect(a.facts).toBeNull()
    expect(codes(a.blockers)).toEqual(['unsupported-ats'])
  })

  it('a recognized provider with no posting id has nothing to submit against', () => {
    const a = assessSubmitCapability(readyInput({ target: { ...GREENHOUSE_TARGET, jobId: null } }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('missing-posting-id')
  })
})

describe('assessSubmitCapability — consent and demographics stay with the person', () => {
  it('a posting that requires GDPR consent is never auto-submitted', () => {
    const a = assessSubmitCapability(readyInput({ formFacts: readGreenhouseFormFacts(CONSENT_REQUIRED) }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('consent-required')
    expect(describeBlockers(a.blockers)).toMatch(/Consent is yours to give/)
  })

  it('an OPTIONAL EEO survey does not block, but is flagged as left blank on purpose', () => {
    const a = assessSubmitCapability(readyInput({ formFacts: readGreenhouseFormFacts(WITH_DEMOGRAPHIC_SURVEY) }))
    expect(a.route).toBe('official-api')
    expect(a.warnings.join(' ')).toMatch(/left blank — those answers are yours alone/)
  })

  it('the never-submitted field list covers every demographic and legal answer field', () => {
    for (const f of ['gender', 'race', 'veteran_status', 'disability_status', 'demographic_answers']) {
      expect(NEVER_SUBMITTED_FIELDS).toContain(f)
    }
  })
})

describe('assessSubmitCapability — identity and knock-outs', () => {
  it('an incomplete identity blocks even when everything else is green', () => {
    for (const bad of [{ ...PROFILE, email: '' }, { ...PROFILE, email: 'not-an-email' }, { ...PROFILE, firstName: '' }]) {
      const a = assessSubmitCapability(readyInput({ profile: bad }))
      expect(a.route).toBe('handoff')
      expect(codes(a.blockers)).toContain('identity-incomplete')
    }
  })

  it('no resume content blocks — an application without a resume is not one we send', () => {
    const a = assessSubmitCapability(readyInput({ hasResumeContent: false }))
    expect(codes(a.blockers)).toContain('identity-incomplete')
  })

  it('a knock-out question in the job description blocks regardless of the form schema', () => {
    const a = assessSubmitCapability(
      readyInput({ jobDescription: 'We do not offer visa sponsorship; you must be authorized to work in the US.' })
    )
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('knockout-question')
  })
})

describe('assessSubmitCapability — providers with no readable form', () => {
  it('Lever proceeds when authorized, and warns that completeness was unverifiable and about the rate limit', () => {
    const a = assessSubmitCapability(readyInput({ target: LEVER_TARGET, formFacts: null }))
    expect(a.route).toBe('official-api')
    const warned = a.warnings.join(' ')
    expect(warned).toMatch(/does not publish its application form publicly/)
    expect(warned).toMatch(/2\/second/)
    // Lever cannot take a resume FILE over JSON, so the degradation is stated
    // rather than hidden.
    expect(warned).toMatch(/travels as text in the application comments/)
  })

  it('Ashby refuses whenever there is a resume, rather than sending an application without one', () => {
    const a = assessSubmitCapability(readyInput({ target: ASHBY_TARGET, formFacts: null }))
    expect(a.route).toBe('handoff')
    expect(codes(a.blockers)).toContain('resume-not-attachable')
    expect(describeBlockers(a.blockers)).toMatch(/without your resume/)
  })
})

describe('assessSubmitCapability — the happy path is reachable, and only under full evidence', () => {
  it('everything green yields the official-api route with zero blockers', () => {
    const a = assessSubmitCapability(readyInput())
    expect(a.route).toBe('official-api')
    expect(a.blockers).toEqual([])
    expect(a.facts?.provider).toBe('greenhouse')
  })

  it('removing ANY single condition from the happy path drops it back to handoff — except the credential, which downgrades to browser-assisted', () => {
    // The point of the gate is that it is a conjunction — no condition is
    // load-bearing on its own and none is skippable. The credential is the
    // one documented exception: see the 'browser-assisted' describe block.
    const mutations: Record<string, Record<string, unknown>> = {
      'no authorization': { authorization: null },
      'no resume': { hasResumeContent: false },
      'no email': { profile: { ...PROFILE, email: '' } },
      'unknown form': { formFacts: null },
      'knockout in JD': { jobDescription: 'Please state your salary expectation.' },
      'no posting id': { target: { ...GREENHOUSE_TARGET, jobId: null } },
    }
    for (const [name, mutation] of Object.entries(mutations)) {
      const a = assessSubmitCapability(readyInput(mutation))
      expect(a.route, `expected handoff when: ${name}`).toBe('handoff')
      expect(a.blockers.length, `expected a stated reason when: ${name}`).toBeGreaterThan(0)
    }
    const noCredential = assessSubmitCapability(readyInput({ hasCredential: false }))
    expect(noCredential.route).toBe('browser-assisted')
  })

  it('every blocker carries a detail that is safe and meaningful to show the user', () => {
    const a = assessSubmitCapability(readyInput({ authorization: null, hasCredential: false, formFacts: null }))
    for (const b of a.blockers) {
      expect(b.detail.length).toBeGreaterThan(20)
      expect(b.detail).not.toMatch(/undefined|null|\[object/)
    }
  })
})

describe('PostingFormFacts stays a closed shape', () => {
  it('facts parsed from a real payload carry their source for the audit trail', () => {
    const facts: PostingFormFacts = readGreenhouseFormFacts(AIRTABLE_REAL)!
    expect(facts.provider).toBe('greenhouse')
    expect(facts.source).toContain('questions=true')
  })
})

// --- end-to-end through submitApplication ------------------------------------
// ZERO NETWORK: global.fetch is mocked and never reaches a real board. These
// prove the gate is wired into the entry point, not merely available beside it.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const GH_JOB_URL = 'https://boards.greenhouse.io/acme/jobs/1234567'

describe('submitApplication — the gate is wired into the entry point', () => {
  it('refuses to POST anything without a human authorization, credential notwithstanding', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: GH_JOB_URL,
      profile: PROFILE,
      content: { resumeFullText: 'REAL RESUME' },
      credentials: { greenhouse: 'api-key' },
      postingForm: readGreenhouseFormFacts(STANDARD_ONLY),
      // no authorization
    })

    expect(result.outcome).toBe('handoff')
    // The decisive assertion: not one byte left the process.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.attempt?.route).toBe('handoff')
    expect(result.attempt?.blockers?.map((b) => b.code)).toContain('missing-human-authorization')
  })

  it('submits when authorized, and the attempt record attests to exactly what was sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 999 }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: GH_JOB_URL,
      profile: PROFILE,
      content: { resumeFullText: 'REAL RESUME', coverLetter: 'Dear team,' },
      credentials: { greenhouse: 'api-key' },
      jobId: 'job-1',
      authorization: { confirmed: true, source: 'submit-confirmed-chain', at: new Date().toISOString(), jobIds: ['job-1'] },
      // Supplied so the run needs no schema round trip; omitting it makes
      // submitApplication read the public schema itself.
      postingForm: readGreenhouseFormFacts(STANDARD_ONLY),
    })

    expect(result.outcome).toBe('submitted')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs/1234567')
    expect(init.method).toBe('POST')

    const attempt = result.attempt!
    expect(attempt.route).toBe('official-api')
    expect(attempt.outcome).toBe('submitted')
    expect(attempt.endpoint).toBe(url)
    expect(attempt.sentValues).toMatchObject({ first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com' })
    expect(attempt.authorization).toMatchObject({ source: 'submit-confirmed-chain' })
    // The body hash pins the exact bytes sent, so the user can prove them later.
    expect(attempt.bodySha256).toMatch(/^[0-9a-f]{64}$/)
    // The resume is attested by digest rather than duplicated into the record.
    const resume = attempt.attachments.find((a) => a.field === 'resume')!
    expect(resume.chars).toBe('REAL RESUME'.length)
    expect(resume.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(attempt)).not.toContain('REAL RESUME')
    // And no credential ever reaches the record.
    expect(JSON.stringify(attempt)).not.toContain('api-key')
  })

  it('a refused attempt is recorded too — the log covers what did NOT go out', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await submitApplication({
      jobUrl: GH_JOB_URL,
      profile: PROFILE,
      content: { resumeFullText: 'REAL RESUME' },
      credentials: { greenhouse: 'api-key' },
      jobId: 'job-1',
      authorization: { confirmed: true, source: 'submit-confirmed-chain', at: new Date().toISOString() },
      // A real posting whose required custom question we cannot answer.
      postingForm: readGreenhouseFormFacts(AIRTABLE_REAL),
    })

    expect(result.outcome).toBe('handoff')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.attempt?.outcome).toBe('handoff')
    expect(result.attempt?.endpoint).toBeNull()
    expect(result.attempt?.blockers?.map((b) => b.code)).toContain('required-question-unanswerable')
  })

  it('a failed schema read never throws — it returns null so the gate can call it unknown', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 404: the post is not live on that board. Greenhouse's own POST validation
    // requires a live, published post, so this is a real and common case.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 })) as unknown as typeof fetch
    await expect(fetchGreenhouseFormFacts(GREENHOUSE_TARGET)).resolves.toBeNull()

    // A 200 carrying something that is not a form schema is equally unknown.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 999 }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchGreenhouseFormFacts(GREENHOUSE_TARGET)).resolves.toBeNull()
    consoleSpy.mockRestore()
  })

  it('the schema read targets the EU board host for EU postings', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(STANDARD_ONLY), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const facts = await fetchGreenhouseFormFacts({
      provider: 'greenhouse',
      slug: 'acme',
      jobId: '1234567',
      host: 'boards.eu.greenhouse.io',
    })
    expect(facts).not.toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs/1234567?questions=true'
    )
    // The record of where the decision came from is the fetched URL, not the template.
    expect(facts!.source).toContain('boards-api.eu.greenhouse.io')
  })

  it('buildDraftAnswers keeps the attempt log append-only across retries', () => {
    const first = buildDraftAnswers('greenhouse', GH_JOB_URL, [], {
      outcome: 'handoff',
      provider: 'greenhouse',
      prefilledUrl: GH_JOB_URL,
      reason: 'blocked',
      fields: [],
      attempt: {
        at: '2026-08-01T00:00:00.000Z',
        provider: 'greenhouse',
        route: 'handoff',
        endpoint: null,
        method: null,
        contentType: null,
        sentValues: {},
        attachments: [],
        bodySha256: null,
        authorization: null,
        outcome: 'handoff',
      },
    })
    expect(first.attempts).toHaveLength(1)

    const second = buildDraftAnswers(
      'greenhouse',
      GH_JOB_URL,
      [],
      {
        outcome: 'submitted',
        provider: 'greenhouse',
        submissionRef: 'greenhouse:999',
        attempt: {
          at: '2026-08-02T00:00:00.000Z',
          provider: 'greenhouse',
          route: 'official-api',
          endpoint: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1234567',
          method: 'POST',
          contentType: 'application/json',
          sentValues: {},
          attachments: [],
          bodySha256: 'x'.repeat(64),
          authorization: null,
          outcome: 'submitted',
        },
      },
      null,
      first.attempts
    )
    // The earlier refusal survives the later success — a user's history of what
    // was and wasn't sent is not overwritten by the happy path.
    expect(second.attempts).toHaveLength(2)
    expect(second.attempts![0].at).toBe('2026-08-01T00:00:00.000Z')
    expect(second.attempts![1].outcome).toBe('submitted')
  })
})
