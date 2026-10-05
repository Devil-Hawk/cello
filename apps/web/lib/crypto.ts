import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

// aes-256-gcm requires exactly 32 bytes: decode 64-char hex keys, scrypt-derive anything else.
//
// Strict mode (Vercel, or NODE_ENV=production) accepts ONLY a 64-char hex
// API_ENCRYPTION_KEY and throws at first use otherwise. The old fallback derived
// the key from NEXT_PUBLIC_SUPABASE_URL, which ships in every browser bundle, so
// "encrypted" rows would have been readable by anyone. The key is resolved
// lazily on purpose: `next build` imports route modules with VERCEL set and no
// secrets, and must not fail. Non-strict (local dev, tests) keeps the old
// behaviour so dev works without a key.
const HEX_64 = /^[0-9a-f]{64}$/i

/** True where a weak or missing key must be refused rather than papered over. */
export function isStrictEnv(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production'
}

let cached: { raw: string | undefined; key: Buffer } | null = null

function getKey(): Buffer {
  const raw = process.env.API_ENCRYPTION_KEY
  if (cached && cached.raw === raw) return cached.key
  let key: Buffer
  if (isStrictEnv()) {
    // Untrimmed on purpose: a stray newline is a different key than the one that was generated.
    if (!raw || !HEX_64.test(raw)) {
      throw new Error(
        'API_ENCRYPTION_KEY must be exactly 64 hex characters in production. Generate one with: openssl rand -hex 32'
      )
    }
    key = Buffer.from(raw, 'hex')
  } else if (raw) {
    key = HEX_64.test(raw) ? Buffer.from(raw, 'hex') : scryptSync(raw, 'salt', 32)
  } else {
    key = scryptSync(process.env.NEXT_PUBLIC_SUPABASE_URL || 'default-key', 'salt', 32) // dev/test only
  }
  cached = { raw, key }
  return key
}

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/**
 * Encrypt a string value
 * Returns base64 encoded string: iv:authTag:encryptedData
 */
export function encrypt(text: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)

  let encrypted = cipher.update(text, 'utf8', 'base64')
  encrypted += cipher.final('base64')

  const authTag = cipher.getAuthTag()

  // Combine iv, authTag, and encrypted data
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`
}

/**
 * Decrypt a string that was encrypted with encrypt()
 */
export function decrypt(encryptedText: string): string {
  const key = getKey()
  const parts = encryptedText.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format')
  }

  const [ivBase64, authTagBase64, encrypted] = parts
  const iv = Buffer.from(ivBase64, 'base64')
  const authTag = Buffer.from(authTagBase64, 'base64')

  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error('Invalid encrypted format')
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encrypted, 'base64', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}

/**
 * Check if a string looks like an encrypted value
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':')
  return parts.length === 3 && parts.every(p => p.length > 0)
}
