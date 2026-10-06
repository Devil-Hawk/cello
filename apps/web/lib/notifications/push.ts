// Web push, to the person's own browsers, with the server's VAPID keys. Message encryption is RFC 8291
// (aes128gcm) and the server's identity is RFC 8292 (VAPID, ES256), both on node:crypto, so there is no
// push library to carry. Without VAPID keys on this server push is off, and the prompt says so.
//
// Env: VAPID_PUBLIC_KEY (base64url, the 65-byte uncompressed point), VAPID_PRIVATE_KEY (base64url, the
// 32-byte scalar), VAPID_SUBJECT (a mailto: or https: address the push service can reach).
// ponytail: one record per message (payloads under about 4 KB) and no retries; a 404 or 410 from the
// push service means the browser unsubscribed, and the caller deletes that subscription.

import { createECDH, createCipheriv, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

export interface PushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

export const PUSH_OFF_SENTENCE = 'Notifications on this device are not set up on this server.'

const b64u = (b: Buffer) => b.toString('base64url')
const fromB64u = (s: string) => Buffer.from(s, 'base64url')

export function vapidKeys(env: NodeJS.ProcessEnv = process.env): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || !privateKey || fromB64u(publicKey).length !== 65 || fromB64u(privateKey).length !== 32) return null
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || 'mailto:support@cello.example' }
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/** RFC 8291: the body to POST, for one browser's p256dh and auth. */
export function encryptPayload(sub: Pick<PushSubscription, 'p256dh' | 'auth'>, payload: Buffer, random = { salt: randomBytes(16), ecdh: createECDH('prime256v1') }): Buffer {
  const uaPublic = fromB64u(sub.p256dh)
  const authSecret = fromB64u(sub.auth)
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys')
  if (payload.length > 3993) throw new Error('payload too large')

  const ecdh = random.ecdh
  ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(uaPublic)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(secret, authSecret, keyInfo, 32)
  const cek = hkdf(ikm, random.salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, random.salt, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // one record: the payload, then the delimiter 0x02 that marks the last record
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  random.salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, encrypted])
}

/** RFC 8292: the Authorization header for a push service origin. */
export function vapidHeader(endpoint: string, keys: { publicKey: string; privateKey: string; subject: string }, nowMs = Date.now()): string {
  const aud = new URL(endpoint).origin
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject })))
  const pub = fromB64u(keys.publicKey)
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' })
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${keys.publicKey}`
}

export type PushResult = 'sent' | 'gone' | 'failed' | 'off'

export async function sendPush(sub: PushSubscription, message: { title: string; body: string; url: string }, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  const keys = vapidKeys()
  if (!keys) return 'off'
  let url: URL
  try {
    url = new URL(sub.endpoint)
  } catch {
    return 'gone'
  }
  // only a push service over https, never an address inside the network
  if (url.protocol !== 'https:') return 'gone'
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
        Authorization: vapidHeader(sub.endpoint, keys),
      },
      body: new Uint8Array(encryptPayload(sub, Buffer.from(JSON.stringify(message)))),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404 || res.status === 410) return 'gone'
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
