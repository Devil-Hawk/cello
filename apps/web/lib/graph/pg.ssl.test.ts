// sslFor() must make pg VERIFY the server for every non-local host. The last
// test proves it against a real TLS endpoint: a local server with a self-signed
// certificate speaks just enough of the Postgres SSLRequest handshake for pg to
// start TLS, and pg has to refuse it.

import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sslFor } from './pg'
import { SUPABASE_ROOT_CA_2021 } from './supabase-root-ca'

describe('sslFor', () => {
  it('uses no TLS for local Postgres', () => {
    expect(sslFor('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe(false)
    expect(sslFor('postgresql://postgres:postgres@localhost:54322/postgres')).toBe(false)
  })

  it('pins the Supabase root and verifies the chain for every other host', () => {
    for (const cs of [
      'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      'postgresql://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres',
      'postgresql://u:p@10.0.0.5:5432/postgres',
    ]) {
      expect(sslFor(cs)).toEqual({ ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true })
    }
  })

  it('embeds the Supabase Root 2021 CA, not some other certificate', () => {
    const x = new X509Certificate(SUPABASE_ROOT_CA_2021)
    expect(x.subject).toContain('Supabase Root 2021 CA')
    expect(x.fingerprint256).toBe(
      '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
    )
    expect(new Date(x.validTo).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('sslFor against an untrusted server', () => {
  let dir: string
  let key: string
  let cert: string
  let server: net.Server
  let port: number
  let handshakes = 0
  // 127.0.0.2 is loopback on Linux but is not 'localhost'/'127.0.0.1', so
  // sslFor treats it as a remote host and returns the verifying options.
  const HOST = '127.0.0.2'

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cello-tls-'))
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
        '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=IP:${HOST}`,
      ],
      { stdio: 'ignore' }
    )
    key = readFileSync(path.join(dir, 'k.pem'), 'utf8')
    cert = readFileSync(path.join(dir, 'c.pem'), 'utf8')

    server = net.createServer((raw) => {
      raw.once('data', () => {
        raw.write('S') // Postgres SSLRequest accepted: upgrade to TLS
        const secure = new tls.TLSSocket(raw, { isServer: true, key, cert })
        secure.on('secure', () => {
          handshakes++
          secure.destroy()
        })
        secure.on('error', () => {})
      })
      raw.on('error', () => {})
    })
    await new Promise<void>((r) => server.listen(0, HOST, r))
    port = (server.address() as net.AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    rmSync(dir, { recursive: true, force: true })
  })

  const connect = (ssl: unknown) =>
    new Client({ host: HOST, port, user: 'u', password: 'p', database: 'd', ssl: ssl as never }).connect()

  it('pg refuses a self-signed certificate with the options sslFor returns', async () => {
    const ssl = sslFor(`postgresql://u:p@${HOST}:${port}/d`)
    expect(ssl).not.toBe(false)
    const before = handshakes
    await expect(connect(ssl)).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i)
    expect(handshakes).toBe(before)
  })

  it('control: the same server completes TLS once its cert is trusted, so the refusal above is verification', async () => {
    const before = handshakes
    // Chain trusted (hostname check skipped: pg sends no SNI for an IP host), then the fake server hangs up.
    await expect(connect({ ca: cert, rejectUnauthorized: true, checkServerIdentity: () => undefined })).rejects.toThrow(
      /terminated|ended|closed|ECONNRESET/i
    )
    expect(handshakes).toBe(before + 1)
  })
})
