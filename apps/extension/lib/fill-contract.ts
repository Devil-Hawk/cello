// lane-stub: K8 fill contract
//
// The routes the extension calls and the read-back allowlist, as agentic-serving-v2
// writes them. When apps/web/lib/fill/contract.ts is on main this file becomes a
// one-line re-export of it. The extension calls only these routes.

export const ROUTES = {
  session: '/api/fill/session',
  report: '/api/fill/report',
  draft: '/api/fill/draft',
  next: '/api/fill/next',
  pause: '/api/pipeline/pause',
} as const
export type Route = (typeof ROUTES)[keyof typeof ROUTES]

/** Why a fill or an automatic send handed the application back to the person. */
export type StopCause =
  | 'sign_in'
  | 'account'
  | 'site_check'
  | 'unknown_field'
  | 'prefilled'
  | 'wrong_page'
  | 'upload'
  | 'form_changed'
  | 'no_submit'
  | 'form_error'
  | 'interrupted'

/** One visible field, as the extension reads it. */
export interface FieldInfo {
  key: string
  label: string
  name: string
  autocomplete: string
  type: string
  options: string[]
  required: boolean
}

export interface SessionRequest {
  url: string
  fields: FieldInfo[]
  auto?: boolean
  application?: string
}

export interface SessionValue {
  value: string | boolean
  /** profile, person, resume or draft: where the value came from. */
  source: string
}

export interface SessionFile {
  /** Key of the file field the resume goes into, when the server knows it. */
  field?: string
  name: string
  /** Path on the Cello origin, fetched with the token. */
  url: string
  sha256: string
}

export type SessionResponse =
  | {
      status: 'ok'
      application: string
      session: string
      company: string
      values: Record<string, SessionValue>
      /** Category per field key: sensitive, eeo, consent, motivation or standard. */
      categories: Record<string, string>
      /** Field keys where "Draft this" is offered. */
      drafts: string[]
      file: SessionFile | null
      /** Hash of the field list the server stored while preparing (automatic sends). */
      fields_hash?: string
    }
  | { status: 'none'; message: string }
  | { status: 'refused'; reason: string; message: string }
  | { status: 'ended'; cause: StopCause; message: string }

export interface DraftRequest {
  application: string
  field: string
}
export interface DraftResponse {
  text: string
}

export type ReportBody =
  | { phase: 'filled'; application: string; filled: number; total: number; unknown: string[] }
  | { phase: 'blocked'; application?: string; url: string; cause: StopCause; detail?: string }
  | { phase: 'submitted'; application: string; auto?: boolean; values: ReadBack; url: string }
  | { phase: 'confirmation'; application: string; text: string; url: string; screenshot?: string }
  | { phase: 'abandoned'; application: string }
  | {
      phase: 'ready_to_send'
      application: string
      fields_hash: string
      values_hash: string
      submit_label: string
      file_hashes: string[]
      final_url: string
    }
  | { phase: 'unconfirmed'; application: string; cause: string }

export type ReportResponse = { ok: true; go?: boolean; already_sent?: boolean } | { ok: false; message: string }

/** What `POST /api/fill/next` answers: always the minimum version, a claim only when one is allowed. */
export interface NextRequest {
  /** True for the alarm's presence call, false when the person asks for the next ready one. */
  auto: boolean
  version: string
}
export interface AutoHost {
  host: string
  /** Regular expression source; named groups `board` and `job`. */
  url_pattern: string
  submit_labels: string[]
  confirmation_patterns: string[]
  confirmation_urls: string[]
}
export interface Claim {
  application: string
  url: string
  company: string
  hosts: AutoHost[]
}
export interface NextResponse {
  min_version?: string
  claim?: Claim
  /** For the person's own "Send next": the next ready application's page. */
  next?: { application: string; url: string; company: string }
}

export interface PauseRequest {
  paused: boolean
}

/** The read-back allowlist: what a submitted form may report. */
export type ReadBackValue = string | boolean | { answered_by_you: true } | { file: string }
export type ReadBack = Record<string, ReadBackValue>
