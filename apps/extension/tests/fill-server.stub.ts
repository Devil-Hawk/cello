// lane-stub: K18 fill routes
//
// A Node http server on 127.0.0.1 that answers the fill contract's routes the way
// K18's routes will, records every request for the specs to assert on, and is
// configured per test. The test build of the extension bakes in this origin.
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Claim, FieldInfo, SessionResponse } from '../lib/fill-contract'
import { fieldsSignature } from '../fill/read-fields'

export const STUB_PORT = 4599
export const TOKEN = 'test-token'
/** The relay credential: a different token with a different scope. The fill routes refuse it. */
export const RELAY_TOKEN = 'relay-token'
export const RESUME_BYTES = Buffer.from('%PDF-1.4 fixture resume for Ada Lovelace\n', 'utf8')
export const RESUME_SHA = createHash('sha256').update(RESUME_BYTES).digest('hex')

export interface Recorded {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

const PROFILE: Record<string, string> = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  phone: '555 0100',
  linkedin: 'https://linkedin.com/in/ada',
  location: 'London',
  name: 'Ada Lovelace',
  org: 'Analytical Engines',
  'urls[LinkedIn]': 'https://linkedin.com/in/ada',
  _systemfield_name: 'Ada Lovelace',
  _systemfield_email: 'ada@example.com',
}
const CATEGORIES: Record<string, string> = { gender: 'eeo', consent: 'consent', agree: 'consent', why: 'motivation' }

export interface StubConfig {
  /** The claim handed out by /api/fill/next when the call asks for one. */
  claim: Claim | null
  /** True: the claim is handed out once. False: every call gets it (a server that repeats itself). */
  claimOnce: boolean
  minVersion: string
  /** The fill hash the server stored. 'wrong' makes the live form look changed. */
  formHash: 'echo' | 'wrong'
  ready: 'go' | 'no' | 'already_sent'
  sessionDelayMs: number
  /** Replaces the session answer entirely (none, refused, ended). */
  session: SessionResponse | null
  /** Offer the resume file with the session. */
  file: boolean
  /** Extra values by field name. */
  profile: Record<string, string>
  /** The next ready application, for Send next. */
  nextReady: { application: string; url: string; company: string } | null
  /** The model job handed out once by /api/model-jobs/claim. */
  relayJob: { job_id: string; claim_id: string; request: unknown } | null
}

const defaults = (): StubConfig => ({
  claim: null,
  claimOnce: true,
  minVersion: '0.0.1',
  formHash: 'echo',
  ready: 'go',
  sessionDelayMs: 0,
  session: null,
  file: true,
  profile: {},
  nextReady: null,
  relayJob: null,
})

export class Stub {
  cfg: StubConfig = defaults()
  requests: Recorded[] = []
  private server: http.Server

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(STUB_PORT, '127.0.0.1', resolve))
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  reset(): void {
    this.cfg = defaults()
    this.requests = []
  }

  /** Requests to a path, optionally only a report phase. */
  calls(path: string, phase?: string): Recorded[] {
    return this.requests.filter((r) => r.path === path && (phase === undefined || r.body.phase === phase))
  }
  reports(phase: string): Recorded[] {
    return this.calls('/api/fill/report', phase)
  }

  private values(fields: FieldInfo[]): { values: Record<string, { value: string; source: string }>; categories: Record<string, string>; drafts: string[] } {
    const values: Record<string, { value: string; source: string }> = {}
    const categories: Record<string, string> = {}
    const drafts: string[] = []
    const profile = { ...PROFILE, ...this.cfg.profile }
    for (const f of fields) {
      const cat = CATEGORIES[f.name]
      if (cat) categories[f.key] = cat
      if (cat === 'motivation') drafts.push(f.key)
      const v = profile[f.name]
      if (v !== undefined && f.type !== 'password' && f.type !== 'hidden') values[f.key] = { value: v, source: 'profile' }
    }
    return { values, categories, drafts }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      body = {}
    }
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    }
    const send = (status: number, data: unknown, type = 'application/json'): void => {
      res.writeHead(status, { 'content-type': type, ...cors })
      res.end(Buffer.isBuffer(data) ? data : typeof data === 'string' ? data : JSON.stringify(data))
    }
    if (req.method === 'OPTIONS') return send(204, '')
    // A page on the Cello origin, for the specs that hand the extension its token the way Cello does.
    if (url.pathname === '/__page/connect') return send(200, '<!doctype html><title>Cello</title><p>Cello</p>', 'text/html')
    // The model job routes take the relay token only; the fill routes below take the fill token only.
    if (url.pathname.startsWith('/api/model-jobs/')) {
      if (req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) return send(401, { error: 'unauthorized' })
      this.requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body })
      if (url.pathname.endsWith('/claim')) {
        const job = this.cfg.relayJob
        this.cfg.relayJob = null
        return send(200, { job })
      }
      return send(200, { ok: true })
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' })
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body })

    switch (url.pathname) {
      case '/api/fill/session': {
        if (this.cfg.sessionDelayMs) await new Promise((r) => setTimeout(r, this.cfg.sessionDelayMs))
        if (this.cfg.session) return send(200, this.cfg.session)
        const fields = (body.fields as FieldInfo[]) ?? []
        const v = this.values(fields)
        const ok: SessionResponse = {
          status: 'ok',
          application: (body.application as string) || 'app-1',
          session: 'session-1',
          company: 'Acme',
          values: v.values,
          categories: v.categories,
          drafts: v.drafts,
          file: this.cfg.file ? { name: 'Ada-Lovelace.pdf', url: '/files/resume.pdf', sha256: RESUME_SHA } : null,
          ...(body.auto
            ? {
                fields_hash:
                  this.cfg.formHash === 'wrong'
                    ? '0'.repeat(64)
                    : createHash('sha256').update(fieldsSignature(fields)).digest('hex'),
              }
            : {}),
        }
        return send(200, ok)
      }
      case '/files/resume.pdf':
        return send(200, RESUME_BYTES, 'application/pdf')
      case '/api/fill/draft':
        return send(200, { text: 'I like building tools that people use every day.' })
      case '/api/fill/report': {
        if (body.phase === 'ready_to_send') {
          if (this.cfg.ready === 'already_sent') return send(200, { ok: true, already_sent: true })
          return send(200, { ok: true, go: this.cfg.ready === 'go' })
        }
        return send(200, { ok: true })
      }
      case '/api/fill/next': {
        let claim: Claim | undefined
        if (body.auto && this.cfg.claim) {
          claim = this.cfg.claim
          if (this.cfg.claimOnce) this.cfg.claim = null
        }
        return send(200, {
          min_version: this.cfg.minVersion,
          ...(claim ? { claim } : {}),
          ...(!body.auto && this.cfg.nextReady ? { next: this.cfg.nextReady } : {}),
        })
      }
      case '/api/pipeline/pause':
        return send(200, { ok: true, paused: body.paused })
      default:
        return send(404, { error: 'not found' })
    }
  }
}
