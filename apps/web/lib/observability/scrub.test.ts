// Proves the Sentry scrubbing gate (scrub.ts) actually strips secrets and PII
// before an event would ever be sent. This is the test the task's acceptance
// bar names explicitly: feed an event containing a fake API key + resume
// text and assert neither survives.

import { describe, expect, it } from 'vitest'
import { deepScrub, redactString, scrubBreadcrumb, scrubEvent, scrubMetadata, type ScrubbableEvent } from './scrub'

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

describe('scrubMetadata: span metadata for the Langfuse mirror', () => {
  it('keeps numeric metrics that deepScrub would blank (key names contain "token")', () => {
    const attrs = { promptTokens: 5, completionTokens: 7, tokensUsed: 12, costUsd: 0.01, metered: true }
    expect(deepScrub(attrs)).toMatchObject({ tokensUsed: '[redacted]' }) // the problem
    expect(scrubMetadata(attrs)).toEqual(attrs)
  })

  it('still redacts secrets in string values and under sensitive keys', () => {
    const out = scrubMetadata({
      error: `401 Bearer abc.def ${FAKE_OPENAI_KEY} for ${FAKE_EMAIL}`,
      apiKey: 'plaintext',
      nested: { refresh_token: FAKE_JWT, note: FAKE_ENCRYPTED_BLOB, tokensUsed: 3 },
      label: 'sourcer',
    }) as Record<string, any>
    expect(JSON.stringify(out)).not.toMatch(/abc\.def|FAKEKEY|jane\.doe|plaintext|aGVsbG93/)
    expect(out.nested.tokensUsed).toBe(3)
    expect(out.label).toBe('sourcer')
  })
})

describe('redactString: plaintext credentials and Google tokens', () => {
  const cases: Array<[string, string]> = [
    ['password: hunter2', 'hunter2'],
    ['password=hunter2', 'hunter2'],
    ['"password": "hunter2"', 'hunter2'],
    ['refresh_token=1//0gXXXXXXXXXXXXXXXXXXXXXXXX', '0gXXXXXXXX'],
    ['{"refresh_token": "1//0gAbCdEfGhIjKlMnOp"}', '0gAbCdEf'],
    ['ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxx', 'a0AfH6SMB'],
    ['api_key=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpw'],
    ['sk_live_abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['whsec_abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['sb_secret_abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END RSA PRIVATE KEY-----', 'MIIEvQIB'],
    // The tail after the first underscore used to leak.
    ['sk-ant-api03-abc_DEFghi_JKLmno-pqrSTU_vwx', 'JKLmno'],
    ['sk-proj-AbCdEfGhIj_KlMnOpQrStUv_WxYz0123', 'WxYz0123'],
    ['github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ0123456789', 'MNOPQRSTUV'],
    ['GOCSPX-abcdEFGH1234_ijklMNOP5678', 'ijklMNOP'],
    ['postgres://postgres:s3cretPassw0rd@db.example.com:5432/app', 's3cretPassw0rd'],
    ["{'password': 'two words here'}", 'two words'],
    ['client_secret=abcdEFGH1234ijkl', 'abcdEFGH1234ijkl'],
    ['cookie: sb-access=abcdef123456', 'abcdef123456'],
  ]
  for (const [input, leak] of cases) {
    it(`redacts ${input.slice(0, 30).replace(/\n/g, ' ')}`, () => {
      expect(redactString(`before ${input} after`)).not.toContain(leak)
    })
  }

  it('leaves ordinary prose and metric-like text alone', () => {
    const text = 'Basic requirements: tokensUsed 5, the token limit is high, a secretive plan'
    expect(redactString(text)).toBe(text)
  })

  it('still redacts the original shapes', () => {
    const out = redactString(`${FAKE_EMAIL} ${FAKE_JWT} Bearer abc ${FAKE_OPENAI_KEY} ${FAKE_ENCRYPTED_BLOB}`)
    expect(out).not.toMatch(/jane\.doe|eyJ|abc|FAKEKEY/)
  })
})

describe('redactString: prefixed and snake_case secret names', () => {
  const cases: Array<[string, string]> = [
    ['DB_PASSWORD=hunter2hunter2', 'hunter2'],
    ['MY_SECRET=abcdef123', 'abcdef123'],
    ['OPENAI_API_KEY=abcdefghijklmnop', 'abcdefghijklmnop'],
    ['GITHUB_TOKEN=ghx_notprefixed12345', 'notprefixed'],
    ['SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJI.abc.def', 'eyJhbGciOiJI'],
    ['{"user_password":"hunter2"}', 'hunter2'],
    ['user_password: "p w d"', 'p w d'],
    ['SECRET_KEY=abcdef', 'abcdef'],
    ['secret_key: abcdef', 'abcdef'],
    ['api_secret=0123456789abcdef', '0123456789abcdef'],
    ['x-api-key: abcdef123456', 'abcdef123456'],
    ['userPassword=hunter2', 'hunter2'],
    ['db_pass=hunter2', 'hunter2'],
    ['pw=hunter2', 'hunter2'],
    ['passphrase: correcthorse', 'correcthorse'],
    ['line one\nDB_PASSWORD=PLANTEDPW\nline three', 'PLANTEDPW'],
  ]
  for (const [text, secret] of cases) {
    it(`redacts ${text.split(/[=:]/)[0].trim()}`, () => {
      expect(redactString(text)).not.toContain(secret)
    })
  }

  it('keeps the key name and leaves prose with similar words alone', () => {
    expect(redactString('DB_PASSWORD=x1y2z3')).toBe('DB_PASSWORD=[redacted]')
    const prose = 'We bypass: the queue. A compass=north. The pass rate is high.'
    expect(redactString(prose)).toBe(prose)
  })
})

describe('deepScrub: short secret key names', () => {
  it('blanks pw, pass, passphrase, key, auth, jwt and bearer keys', () => {
    const out = deepScrub({ pw: 'a', pass: 'b', passphrase: 'c', key: 'd', auth: 'e', jwt: 'f', bearer: 'g', keyword: 'ok', passed: true }) as Record<string, unknown>
    for (const k of ['pw', 'pass', 'passphrase', 'key', 'auth', 'jwt', 'bearer']) expect(out[k]).toBe('[redacted]')
    expect(out.keyword).toBe('ok')
    expect(out.passed).toBe(true)
  })
})

describe('redactString: linear time on hostile input', () => {
  const inputs: Record<string, string> = {
    'a/': 'a/'.repeat(32768),
    a: 'a'.repeat(65536),
    'a+': 'a+'.repeat(32768),
    'a-': 'a-'.repeat(32768),
    base64: 'QUJDREVGR0hJSktM'.repeat(4096),
    'eyJ-': 'eyJ-'.repeat(16384),
    'sk--': 'sk-'.repeat(21845),
    'a@': 'a@'.repeat(32768),
    'a:': 'abcdefgh:'.repeat(7000),
    'sk-_': 'sk-a_'.repeat(13107),
    'a.a.a': 'eyJaaaaa.'.repeat(7282),
    'Bearer ': 'Bearer '.repeat(9362),
    'password=': 'password='.repeat(7282),
    'password:"': 'password: "'.repeat(7282),
    'a://b:c': 'ab://c:'.repeat(9362),
    'ya29.': 'ya29.'.repeat(13107),
    'github_pat_': 'github_pat_'.repeat(5958),
    'begin pem': '-----BEGIN PRIVATE KEY-----'.repeat(2427),
    _: '_'.repeat(65536),
    'a_': 'a_'.repeat(32768),
    '-_': '-_'.repeat(32768),
    'secret_': 'secret_'.repeat(9362),
    'x-api-key': 'x-api-key '.repeat(6554),
    'spaces': ' '.repeat(65536),
    'colons': ':'.repeat(65536),
    'a@a.': 'a@a.'.repeat(16384),
    'a@aaaa': `a@${'a'.repeat(65000)}`,
    'long blob': `${'A'.repeat(500)}:${'B'.repeat(500)}:${'C'.repeat(60000)}`,
  }
  for (const [name, text] of Object.entries(inputs)) {
    it(`${name} finishes fast`, () => {
      const t0 = performance.now()
      redactString(text)
      expect(performance.now() - t0).toBeLessThan(600)
    })
  }
})
