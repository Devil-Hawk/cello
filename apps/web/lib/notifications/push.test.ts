// Web push on node:crypto: the encrypted body opens with the browser's keys the way RFC 8291 says, the
// VAPID header is a signed ES256 token for the push service's origin, and without keys push is off.

import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptPayload, isPushEndpoint, sendPush, vapidHeader, vapidKeys } from './push'

const b64u = (b: Buffer) => b.toString('base64url')

// RFC 5869 HKDF with SHA-256, written out here so the test does not lean on the code it checks
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  let t = Buffer.alloc(0)
  let okm = Buffer.alloc(0)
  for (let i = 1; okm.length < length; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest()
    okm = Buffer.concat([okm, t])
  }
  return okm.subarray(0, length)
}

describe('encryptPayload', () => {
  it('opens with the browser keys: RFC 8291, one record', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const message = Buffer.from(JSON.stringify({ title: 'Cello', body: 'Acme wrote to you about Backend Engineer.', url: '/applications/a1' }))
    const body = encryptPayload({ p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }, message)

    const salt = body.subarray(0, 16)
    expect(body.readUInt32BE(16)).toBe(4096)
    const idlen = body.readUInt8(20)
    expect(idlen).toBe(65)
    const asPublic = body.subarray(21, 21 + idlen)
    const record = body.subarray(21 + idlen)

    const secret = ua.computeSecret(asPublic)
    const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32)
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
    const d = createDecipheriv('aes-128-gcm', cek, nonce)
    d.setAuthTag(record.subarray(record.length - 16))
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
    expect(plain.subarray(0, plain.length - 1).toString()).toBe(message.toString())
    expect(plain[plain.length - 1]).toBe(2)
  })

  it('refuses keys of the wrong size and a payload that does not fit', () => {
    expect(() => encryptPayload({ p256dh: 'AAAA', auth: 'AAAA' }, Buffer.from('x'))).toThrow()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    expect(() => encryptPayload({ p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) }, Buffer.alloc(4000))).toThrow('payload too large')
  })
})

describe('RFC 8291 appendix A', () => {
  it('produces the RFC\'s own encrypted message from its keys', () => {
    const asPrivate = Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(asPrivate)
    const body = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'),
      { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), ecdh },
    )
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })
})

describe('where a push may go', () => {
  it('only to a browser\'s own push service over https', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc', 'https://wns2-par02p.notify.windows.com/w/?token=x']) expect(isPushEndpoint(ok)).toBe(true)
    for (const no of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://10.0.0.5/x', 'https://push.example/x', 'https://fcm.googleapis.com.evil.test/x', 'https://evil.test/fcm.googleapis.com', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'not a url']) expect(isPushEndpoint(no)).toBe(false)
  })

  it('never calls the network for an endpoint outside that list', async () => {
    const k = createECDH('prime256v1')
    k.generateKeys()
    process.env.VAPID_PUBLIC_KEY = b64u(k.getPublicKey())
    process.env.VAPID_PRIVATE_KEY = b64u(k.getPrivateKey())
    try {
      let called = false
      const r = await sendPush({ endpoint: 'https://169.254.169.254/latest', p256dh: 'a', auth: 'b' }, { title: 't', body: 'b', url: '/' }, (async () => ((called = true), new Response())) as typeof fetch)
      expect(r).toBe('gone')
      expect(called).toBe(false)
    } finally {
      delete process.env.VAPID_PUBLIC_KEY
      delete process.env.VAPID_PRIVATE_KEY
    }
  })
})

describe('vapidHeader', () => {
  it('is an ES256 token for the push service origin that the public key verifies', () => {
    const k = createECDH('prime256v1')
    k.generateKeys()
    const keys = { publicKey: b64u(k.getPublicKey()), privateKey: b64u(k.getPrivateKey()), subject: 'mailto:me@example.com' }
    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 1_800_000_000_000)
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
    expect(m).not.toBeNull()
    const claims = JSON.parse(Buffer.from(m![2], 'base64url').toString())
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:me@example.com' })
    expect(claims.exp).toBe(1_800_000_000 + 12 * 3600)
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(k.getPublicKey().subarray(1, 33)), y: b64u(k.getPublicKey().subarray(33, 65)) }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${m![1]}.${m![2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m![3], 'base64url'))).toBe(true)
    expect(m![4]).toBe(keys.publicKey)
  })
})

describe('without the owner\'s keys', () => {
  it('is off, and says so by returning off without calling the network', async () => {
    const had = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY }
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    let called = false
    const r = await sendPush({ endpoint: 'https://push.example/x', p256dh: 'a', auth: 'b' }, { title: 't', body: 'b', url: '/' }, (async () => ((called = true), new Response())) as typeof fetch)
    expect(r).toBe('off')
    expect(called).toBe(false)
    expect(vapidKeys({} as NodeJS.ProcessEnv)).toBeNull()
    if (had.pub) process.env.VAPID_PUBLIC_KEY = had.pub
    if (had.priv) process.env.VAPID_PRIVATE_KEY = had.priv
  })
})
