import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

// Use environment variable for encryption key, fallback to a derived key from Supabase URL
// In production, always set API_ENCRYPTION_KEY environment variable
// aes-256-gcm requires exactly 32 bytes: decode 64-char hex keys, scrypt-derive anything else
const rawKey = process.env.API_ENCRYPTION_KEY
const ENCRYPTION_KEY = rawKey
  ? (/^[0-9a-f]{64}$/i.test(rawKey) ? Buffer.from(rawKey, 'hex') : scryptSync(rawKey, 'salt', 32))
  : scryptSync(process.env.NEXT_PUBLIC_SUPABASE_URL || 'default-key', 'salt', 32)

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/**
 * Encrypt a string value
 * Returns base64 encoded string: iv:authTag:encryptedData
 */
export function encrypt(text: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv)

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
  const parts = encryptedText.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format')
  }

  const [ivBase64, authTagBase64, encrypted] = parts
  const iv = Buffer.from(ivBase64, 'base64')
  const authTag = Buffer.from(authTagBase64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv)
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
