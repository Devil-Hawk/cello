// Tests for lib/crypto.ts — the AES-256-GCM envelope guarding every stored
// API key. Covers: encrypt/decrypt round-trips; a tampered ciphertext fails
// AUTHENTICATION (throws) rather than silently returning corrupted plaintext;
// both key-derivation paths (raw 64-hex key vs scrypt-derived from an
// arbitrary passphrase) actually take effect, not just "don't throw".
//
// ENCRYPTION_KEY is computed ONCE at module load from process.env, so each
// "which key path" test sets process.env.API_ENCRYPTION_KEY, resets the
// module registry, and re-imports fresh — otherwise every test after the
// first would silently reuse whatever key happened to be cached first.

import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_KEY_ENV = process.env.API_ENCRYPTION_KEY
const ORIGINAL_SUPABASE_URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL

afterEach(() => {
  if (ORIGINAL_KEY_ENV === undefined) delete process.env.API_ENCRYPTION_KEY
  else process.env.API_ENCRYPTION_KEY = ORIGINAL_KEY_ENV
  if (ORIGINAL_SUPABASE_URL_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL_ENV
  vi.resetModules()
})

/** Fresh import of lib/crypto.ts with the CURRENT process.env baked in. */
async function freshCrypto() {
  vi.resetModules()
  return import('./crypto')
}

describe('encrypt/decrypt — round trip', () => {
  it('decrypt(encrypt(x)) === x for ordinary text', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt, decrypt } = await freshCrypto()
    const plaintext = 'sk-openrouter-abc123-super-secret-key'
    const ciphertext = encrypt(plaintext)
    expect(decrypt(ciphertext)).toBe(plaintext)
  })

  it('round-trips empty string, unicode, and long text', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt, decrypt } = await freshCrypto()
    for (const plaintext of ['', '🔑 unicode key ünïcödé', 'x'.repeat(10_000)]) {
      expect(decrypt(encrypt(plaintext))).toBe(plaintext)
    }
  })

  it('two encryptions of the same plaintext produce DIFFERENT ciphertext (random IV per call)', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt } = await freshCrypto()
    const a = encrypt('same value')
    const b = encrypt('same value')
    expect(a).not.toBe(b)
  })

  it('ciphertext is the documented iv:authTag:encrypted base64 triple', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt } = await freshCrypto()
    const ciphertext = encrypt('hello')
    const parts = ciphertext.split(':')
    expect(parts).toHaveLength(3)
    for (const p of parts) expect(() => Buffer.from(p, 'base64')).not.toThrow()
    // IV is 16 bytes, authTag is 16 bytes, per the module's constants.
    expect(Buffer.from(parts[0], 'base64')).toHaveLength(16)
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(16)
  })
})

describe('decrypt — a tampered ciphertext fails AUTHENTICATION, never returns garbage silently', () => {
  it('flipping a byte in the encrypted payload throws rather than returning corrupted plaintext', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt, decrypt } = await freshCrypto()
    const ciphertext = encrypt('a secret api key')
    const [iv, authTag, encrypted] = ciphertext.split(':')

    const bytes = Buffer.from(encrypted, 'base64')
    bytes[0] = bytes[0] ^ 0xff // flip the first byte
    const tampered = `${iv}:${authTag}:${bytes.toString('base64')}`

    expect(() => decrypt(tampered)).toThrow()
  })

  it('flipping a byte in the auth tag itself throws', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt, decrypt } = await freshCrypto()
    const ciphertext = encrypt('a secret api key')
    const [iv, authTag, encrypted] = ciphertext.split(':')

    const tagBytes = Buffer.from(authTag, 'base64')
    tagBytes[0] = tagBytes[0] ^ 0xff
    const tampered = `${iv}:${tagBytes.toString('base64')}:${encrypted}`

    expect(() => decrypt(tampered)).toThrow()
  })

  it('a ciphertext encrypted under a DIFFERENT key configuration fails to decrypt (proves the key actually changes)', async () => {
    process.env.API_ENCRYPTION_KEY = 'a'.repeat(64) // valid 64-hex key, all "a"
    const { encrypt: encryptA } = await freshCrypto()
    const ciphertext = encryptA('secret value')

    process.env.API_ENCRYPTION_KEY = 'b'.repeat(64) // different valid 64-hex key
    const { decrypt: decryptB } = await freshCrypto()

    expect(() => decryptB(ciphertext)).toThrow()
  })

  it('malformed format (not iv:authTag:data) throws a clear error instead of decrypting garbage', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { decrypt } = await freshCrypto()
    expect(() => decrypt('not-the-right-format')).toThrow('Invalid encrypted format')
    expect(() => decrypt('a:b')).toThrow('Invalid encrypted format')
    expect(() => decrypt('a:b:c:d')).toThrow('Invalid encrypted format')
  })
})

describe('key derivation — both the 64-hex path and the scrypt path work, and actually differ', () => {
  it('a 64-hex-char key is used VERBATIM (hex-decoded), not re-derived through scrypt', async () => {
    const hexKey = randomBytes(32).toString('hex')
    process.env.API_ENCRYPTION_KEY = hexKey
    const { encrypt } = await freshCrypto()
    const ciphertext = encrypt('verbatim hex key test')

    // Decrypt independently using the raw hex-decoded bytes as the AES key,
    // completely bypassing lib/crypto.ts — this proves ENCRYPTION_KEY really
    // is Buffer.from(hexKey, 'hex'), not scryptSync(hexKey, 'salt', 32).
    const [ivB64, authTagB64, encB64] = ciphertext.split(':')
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
    let decrypted = decipher.update(encB64, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    expect(decrypted).toBe('verbatim hex key test')

    // And confirm it is NOT the scrypt-derived key for that same string
    // (i.e. the two derivation paths genuinely diverge for hex input).
    const scryptDerived = scryptSync(hexKey, 'salt', 32)
    const wrongDecipherAttempt = () => {
      const d = createDecipheriv('aes-256-gcm', scryptDerived, Buffer.from(ivB64, 'base64'))
      d.setAuthTag(Buffer.from(authTagB64, 'base64'))
      let out = d.update(encB64, 'base64', 'utf8')
      out += d.final('utf8')
      return out
    }
    expect(wrongDecipherAttempt).toThrow()
  })

  it('a non-hex passphrase is scrypt-derived into a valid 32-byte AES-256-GCM key', async () => {
    process.env.API_ENCRYPTION_KEY = 'my-arbitrary-passphrase-not-hex'
    const { encrypt, decrypt } = await freshCrypto()

    const ciphertext = encrypt('scrypt path round trip')
    expect(decrypt(ciphertext)).toBe('scrypt path round trip')

    // Independently verify the key used really is scryptSync(passphrase, 'salt', 32).
    const [ivB64, authTagB64, encB64] = ciphertext.split(':')
    const expectedKey = scryptSync('my-arbitrary-passphrase-not-hex', 'salt', 32)
    const decipher = createDecipheriv('aes-256-gcm', expectedKey, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
    let decrypted = decipher.update(encB64, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    expect(decrypted).toBe('scrypt path round trip')
  })

  it('a 64-char string that is NOT valid hex (e.g. contains "g"/"z") falls through to the scrypt path, not the raw-hex path', async () => {
    // 64 chars, but 'g' and 'z' are outside [0-9a-f] — must NOT be treated as hex.
    const notHex = 'g'.repeat(32) + 'z'.repeat(32)
    expect(notHex).toHaveLength(64)
    process.env.API_ENCRYPTION_KEY = notHex
    const { encrypt } = await freshCrypto()
    const ciphertext = encrypt('non-hex 64-char passphrase')

    const [ivB64, authTagB64, encB64] = ciphertext.split(':')
    const expectedKey = scryptSync(notHex, 'salt', 32)
    const decipher = createDecipheriv('aes-256-gcm', expectedKey, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
    let decrypted = decipher.update(encB64, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    expect(decrypted).toBe('non-hex 64-char passphrase')
  })

  it('no API_ENCRYPTION_KEY at all derives from NEXT_PUBLIC_SUPABASE_URL (or the hardcoded default), and still round-trips', async () => {
    delete process.env.API_ENCRYPTION_KEY
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    const { encrypt, decrypt } = await freshCrypto()
    const ciphertext = encrypt('fallback key path')
    expect(decrypt(ciphertext)).toBe('fallback key path')

    const [ivB64, authTagB64, encB64] = ciphertext.split(':')
    const expectedKey = scryptSync('https://example.supabase.co', 'salt', 32)
    const decipher = createDecipheriv('aes-256-gcm', expectedKey, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
    let decrypted = decipher.update(encB64, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    expect(decrypted).toBe('fallback key path')
  })
})

describe('isEncrypted', () => {
  it('true for a well-formed iv:authTag:data triple', async () => {
    delete process.env.API_ENCRYPTION_KEY
    const { encrypt, isEncrypted } = await freshCrypto()
    expect(isEncrypted(encrypt('anything'))).toBe(true)
  })

  it('false for plain (unencrypted) text', async () => {
    const { isEncrypted } = await freshCrypto()
    expect(isEncrypted('sk-plain-unencrypted-key')).toBe(false)
  })

  it('false for a string with the wrong number of colon-delimited parts', async () => {
    const { isEncrypted } = await freshCrypto()
    expect(isEncrypted('a:b')).toBe(false)
    expect(isEncrypted('a:b:c:d')).toBe(false)
    expect(isEncrypted('')).toBe(false)
  })

  it('false when a segment is empty (e.g. "a::c")', async () => {
    const { isEncrypted } = await freshCrypto()
    expect(isEncrypted('a::c')).toBe(false)
  })
})
