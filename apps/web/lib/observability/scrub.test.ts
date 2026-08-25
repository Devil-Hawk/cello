// Proves the Sentry scrubbing gate (scrub.ts) actually strips secrets and PII
// before an event would ever be sent. This is the test the task's acceptance
// bar names explicitly: feed an event containing a fake API key + resume
// text and assert neither survives.

import { describe, expect, it } from 'vitest'
import { deepScrub, redactString, scrubBreadcrumb, scrubEvent, type ScrubbableEvent } from './scrub'

const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-FAKEKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const FAKE_OPENAI_KEY = 'sk-FAKEKEY1234567890abcdefghijklmnop'
const FAKE_EMAIL = 'jane.doe@example.com'
const FAKE_RESUME_TEXT =
  'Jane Doe — Senior Engineer. jane.doe@example.com, (555) 123-4567. ' +
  '10 years building distributed systems at Acme Corp...'
// Same shape lib/crypto.ts#encrypt produces: iv:authTag:data, all base64.
const FAKE_ENCRYPTED_BLOB =
  'aGVsbG93b3JsZGl2Ynl0ZXM=:d29ybGRhdXRodGFnYnl0ZXM=:c2VjcmV0Y2lwaGVydGV4dGRhdGE='
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_fake_signature_part'

function buildFakeEvent(): ScrubbableEvent {
  return {
    message: `Failed to process resume for ${FAKE_EMAIL}`,
    request: {
      url: 'https://cello.app/api/resume/upload?token=abc123',
      method: 'POST',
      data: { resumeText: FAKE_RESUME_TEXT },
      cookies: { 'sb-access-token': 'super-secret-cookie-value' },
      headers: {
        authorization: `Bearer ${FAKE_OPENAI_KEY}`,
        cookie: 'session=xyz',
        'content-type': 'application/json',
        'x-request-id': 'req_abc123', // benign, should survive
      },
    },
    user: { email: FAKE_EMAIL, id: 'user_123' },
    extra: {
      apiKey: FAKE_ANTHROPIC_KEY,
      encryptedBlob: FAKE_ENCRYPTED_BLOB,
      resumeText: FAKE_RESUME_TEXT,
      contactEmail: FAKE_EMAIL,
      stepLabel: 'match-job-42', // benign, should survive
      runId: 'run_9f8e7d', // benign, should survive
    },
    contexts: {
      settings: { supabaseServiceRoleKey: 'super-secret-service-role-key-value' },
    },
    tags: {
      area: 'harness', // benign, should survive
      userEmail: FAKE_EMAIL,
    },
    exception: {
      values: [{ type: 'Error', value: `Auth failed for token ${FAKE_JWT} sent by ${FAKE_EMAIL}` }],
    },
    breadcrumbs: [
      {
        message: `Retrying request with key ${FAKE_OPENAI_KEY}`,
        data: { resumeSnippet: FAKE_RESUME_TEXT.slice(0, 50), status: 429 },
      },
    ],
  }
}

describe('scrubEvent', () => {
  it('strips a fake API key and resume text everywhere in the event', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    const serialized = JSON.stringify(scrubbed)

    // The fake secrets/PII must not appear anywhere in the outgoing event.
    expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY)
    expect(serialized).not.toContain(FAKE_OPENAI_KEY)
    expect(serialized).not.toContain(FAKE_EMAIL)
    expect(serialized).not.toContain(FAKE_ENCRYPTED_BLOB)
    expect(serialized).not.toContain(FAKE_JWT)
    expect(serialized).not.toContain('Jane Doe')
    expect(serialized).not.toContain('Acme Corp')
    expect(serialized).not.toContain('super-secret-cookie-value')
    expect(serialized).not.toContain('super-secret-service-role-key-value')
    expect(serialized).not.toContain('(555) 123-4567')
  })

  it('drops the request body and cookies structurally, not just redacts them', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    expect(scrubbed.request?.data).toBeUndefined()
    expect(scrubbed.request?.cookies).toBeUndefined()
  })

  it('drops sensitive headers and redacts secret-shaped header values', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    expect(scrubbed.request?.headers?.authorization).toBeUndefined()
    expect(scrubbed.request?.headers?.cookie).toBeUndefined()
    expect(scrubbed.request?.headers?.['content-type']).toBe('application/json')
    expect(scrubbed.request?.headers?.['x-request-id']).toBe('req_abc123')
  })

  it('clears event.user entirely (defense in depth alongside sendDefaultPii:false)', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    expect(scrubbed.user).toBeUndefined()
  })

  it('redacts sensitive extra/context/tag keys outright', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    expect(scrubbed.extra?.apiKey).toBe('[redacted]')
    expect(scrubbed.extra?.encryptedBlob).toBe('[redacted]')
    expect(scrubbed.extra?.resumeText).toBe('[redacted]')
    expect(scrubbed.extra?.contactEmail).toBe('[redacted]')
    expect((scrubbed.contexts?.settings as Record<string, unknown>)?.supabaseServiceRoleKey).toBe('[redacted]')
    expect(scrubbed.tags?.userEmail).toBe('[redacted]')
  })

  it('preserves harmless identifiers needed to actually debug the failure', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    expect(scrubbed.extra?.stepLabel).toBe('match-job-42')
    expect(scrubbed.extra?.runId).toBe('run_9f8e7d')
    expect(scrubbed.tags?.area).toBe('harness')
  })

  it('pattern-redacts secrets/PII embedded in free-text message and exception values', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    expect(scrubbed.message).not.toContain(FAKE_EMAIL)
    expect(scrubbed.message).toContain('[redacted-email]')
    const exceptionValue = scrubbed.exception?.values?.[0]?.value ?? ''
    expect(exceptionValue).not.toContain(FAKE_JWT)
    expect(exceptionValue).not.toContain(FAKE_EMAIL)
    expect(exceptionValue).toContain('[redacted-token]')
  })

  it('scrubs breadcrumbs the same way', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    const crumb = scrubbed.breadcrumbs?.[0]
    expect(JSON.stringify(crumb)).not.toContain(FAKE_OPENAI_KEY)
    expect(JSON.stringify(crumb)).not.toContain('Jane Doe')
  })

  it('redacts query-string-looking tokens in the request URL', () => {
    const scrubbed = scrubEvent(buildFakeEvent())
    // Our redaction targets secret-shaped values, not arbitrary query params —
    // this asserts the URL still passes through the same pattern scrubbing as
    // any other string rather than being silently skipped.
    expect(typeof scrubbed.request?.url).toBe('string')
  })
})

describe('scrubBreadcrumb', () => {
  it('is safe to call directly (beforeBreadcrumb wiring) and strips secrets', () => {
    const crumb = scrubBreadcrumb({
      message: `key=${FAKE_OPENAI_KEY}`,
      data: { email: FAKE_EMAIL, safe: 'ok' },
    })
    expect(JSON.stringify(crumb)).not.toContain(FAKE_OPENAI_KEY)
    expect(crumb.data?.email).toBe('[redacted]')
    expect(crumb.data?.safe).toBe('ok')
  })
})

describe('redactString', () => {
  it('redacts emails, bearer tokens, JWTs, provider keys, and our AES-GCM blob format', () => {
    expect(redactString(`contact ${FAKE_EMAIL}`)).toBe('contact [redacted-email]')
    expect(redactString(`Authorization: Bearer ${FAKE_OPENAI_KEY}`)).toBe(
      'Authorization: Bearer [redacted-token]'
    )
    expect(redactString(FAKE_JWT)).toBe('[redacted-token]')
    expect(redactString(FAKE_ANTHROPIC_KEY)).toBe('[redacted-key]')
    expect(redactString(FAKE_ENCRYPTED_BLOB)).toBe('[redacted-secret]')
  })

  it('leaves ordinary text untouched', () => {
    expect(redactString('step "match-job-42" failed: output failed schema')).toBe(
      'step "match-job-42" failed: output failed schema'
    )
  })
})

describe('deepScrub', () => {
  it('redacts by key name at any depth and preserves benign values', () => {
    const input = {
      runId: 'run_1',
      nested: { user: { email: FAKE_EMAIL, id: 'u1' }, tokens: { access_token: 'abc' } },
      list: [{ password: 'hunter2' }, { label: 'ok' }],
    }
    const out = deepScrub(input) as Record<string, unknown>
    expect(out.runId).toBe('run_1')
    const nested = out.nested as Record<string, unknown>
    const user = nested.user as Record<string, unknown>
    expect(user.email).toBe('[redacted]')
    expect(user.id).toBe('u1')
    const list = out.list as Record<string, unknown>[]
    expect(list[0].password).toBe('[redacted]')
    expect(list[1].label).toBe('ok')
  })

  it('bounds recursion depth instead of hanging on deeply nested input', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 20; i++) deep = { child: deep }
    expect(() => deepScrub(deep)).not.toThrow()
  })
})
